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
import unicodedata
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
PARENT_SOURCE_EXPORT_BATCH = 500
PARENT_SOURCE_OCCURRENCE_BATCH_ROWS = 100_000
PARENT_VIDEO_EXPORT_BATCH = 500
MAX_SOURCE_SCOPE_ROWS = 5_000_000
SOURCE_WRITE_BATCH_SIZE = 64
SQLITE_CHECKPOINT_ROWS = 2_048
SQLITE_CACHE_DROP_ROWS = 2_048
# A read-only progress probe can briefly hold a shared SQLite lock while the
# private candidate is being written.  The default sqlite3 timeout is only
# five seconds, which is shorter than a full-table count on this snapshot.
# Wait long enough for bounded observers to finish, while still failing
# closed if a lock is genuinely stuck.
SQLITE_BUSY_TIMEOUT_MS = 120_000


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _canonical_song_name_key(value: Any) -> str:
    """Compare display names without treating Unicode/case variants as new songs."""

    return unicodedata.normalize("NFKC", _text(value)).casefold()


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


def validate_complete_ranking_series(
    series_key: str, expected: int, actual: int,
) -> None:
    if actual != expected:
        raise RuntimeError(
            "ranking pages are incomplete: "
            f"{series_key} expected={expected} actual={actual}"
        )


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
        CREATE TEMP TABLE source_scope_artist_identities(
          group_key TEXT NOT NULL,
          priority INTEGER NOT NULL,
          source_key TEXT NOT NULL,
          PRIMARY KEY(group_key,priority,source_key)
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

    def add_artist_identities(
        self, values: Iterable[tuple[str, int, str]],
    ) -> None:
        self.connection.executemany(
            "INSERT OR IGNORE INTO source_scope_artist_identities"
            "(group_key,priority,source_key) VALUES(?,?,?)",
            (
                (_text(group_key), int(priority), _text(source_key))
                for group_key, priority, source_key in values
                if _text(group_key) and _text(source_key)
            ),
        )

    def finalize_artist_targets(self, requested_keys: Iterable[str]) -> None:
        """Resolve Artist aliases with exact canonical identity precedence."""

        requested = sorted({
            _text(value) for value in requested_keys if _text(value)
        })
        if not requested:
            self.connection.execute(
                "DROP TABLE source_scope_artist_identities"
            )
            return
        self.connection.execute(
            "CREATE TEMP TABLE source_scope_requested_artists("
            "source_key TEXT PRIMARY KEY) WITHOUT ROWID"
        )
        self.connection.executemany(
            "INSERT INTO source_scope_requested_artists(source_key) VALUES(?)",
            ((value,) for value in requested),
        )
        rows = self.connection.execute("""
        WITH winning_priority AS (
          SELECT group_key,min(priority) AS priority
          FROM source_scope_artist_identities
          GROUP BY group_key
        ), winning_owners AS (
          SELECT identity.group_key,
                 min(identity.source_key) AS source_key,
                 count(DISTINCT identity.source_key) AS owner_count,
                 max(CASE WHEN requested.source_key IS NULL THEN 0 ELSE 1 END)
                   AS has_requested_owner
          FROM source_scope_artist_identities AS identity
          JOIN winning_priority AS winner
            ON winner.group_key=identity.group_key
           AND winner.priority=identity.priority
          LEFT JOIN source_scope_requested_artists AS requested
            ON requested.source_key=identity.source_key
          GROUP BY identity.group_key
        )
        SELECT group_key,source_key,owner_count
        FROM winning_owners
        WHERE has_requested_owner=1
        ORDER BY group_key
        """).fetchall()
        targets: list[tuple[str, str, str]] = []
        for group_key, source_key, owner_count in rows:
            if int(owner_count) != 1:
                raise RuntimeError(
                    "snapshot Artist alias has multiple canonical owners"
                )
            targets.append(("artists", str(group_key), str(source_key)))
        self.add_targets(targets)
        self.connection.execute("DROP TABLE source_scope_requested_artists")
        self.connection.execute("DROP TABLE source_scope_artist_identities")

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

    def source_batches(
        self,
        source_keys: Iterable[str],
        *,
        batch_size: int = PARENT_SOURCE_EXPORT_BATCH,
    ) -> Iterable[
        tuple[
            tuple[str, ...],
            dict[str, dict[str, tuple[Any, ...]]],
            tuple[str, ...],
        ]
    ]:
        """Yield exact source scopes without one SQLite lookup per key."""

        if batch_size < 1 or batch_size > PARENT_SOURCE_EXPORT_BATCH:
            raise ValueError("invalid snapshot source key batch size")
        ordered = tuple(sorted({
            _text(value) for value in source_keys if _text(value)
        }))
        for offset in range(0, len(ordered), batch_size):
            batch = ordered[offset : offset + batch_size]
            placeholders = ",".join("?" for _ in batch)
            scoped: dict[str, dict[str, list[Any]]] = {
                source_key: {"videos": [], "targets": []}
                for source_key in batch
            }
            for source_key, video_id in self.connection.execute(
                "SELECT source_key,video_id FROM source_scope_pairs "
                f"WHERE source_key IN ({placeholders}) "
                "ORDER BY source_key,video_id",
                batch,
            ):
                scoped[str(source_key)]["videos"].append(str(video_id))
            for source_key, view, group_key in self.connection.execute(
                "SELECT source_key,view,group_key FROM source_scope_targets "
                f"WHERE source_key IN ({placeholders}) "
                "ORDER BY source_key,view,group_key",
                batch,
            ):
                scoped[str(source_key)]["targets"].append(
                    (str(view), str(group_key))
                )
            missing = [
                source_key
                for source_key in batch
                if not scoped[source_key]["videos"]
            ]
            if missing:
                raise RuntimeError(
                    "snapshot source batch has empty exact video scope: "
                    + ", ".join(missing[:10])
                )
            frozen = {
                source_key: {
                    "videos": tuple(values["videos"]),
                    "targets": tuple(values["targets"]),
                }
                for source_key, values in scoped.items()
            }
            union_videos = tuple(sorted({
                video_id
                for values in frozen.values()
                for video_id in values["videos"]
            }))
            if not union_videos:
                raise RuntimeError("snapshot source batch union scope is empty")
            yield batch, frozen, union_videos

    def affected_source_keys(self) -> tuple[str, ...]:
        """Return sources whose exact parent membership intersects a delta video."""

        return tuple(
            str(row[0])
            for row in self.connection.execute(
                "SELECT DISTINCT pair.source_key "
                "FROM source_scope_pairs AS pair "
                "JOIN source_scope_videos AS affected "
                "  ON affected.video_id=pair.video_id "
                "ORDER BY pair.source_key"
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
) -> tuple[set[tuple[str, str]], set[tuple[str, str, str]]]:
    videos = {_text(value) for value in video_ids if _text(value)}
    pairs: set[tuple[str, str]] = set()
    targets: set[tuple[str, str, str]] = set()
    for video_id in videos:
        source_key = adapter._stable_key("source-video", "all", video_id)
        if source_key in requested_keys:
            pairs.add((source_key, video_id))
            targets.add(("videos", video_id, source_key))
    for title, artist in song_pairs:
        normalized_title = adapter._overlay_norm(title)
        normalized_artist = adapter._overlay_norm(artist)
        if not normalized_title:
            continue
        song_group_key = f"{normalized_title}::{normalized_artist}"
        song_keys = {_production_source_key(
            "songs", "all", song_group_key,
        )}
        artist_group_key = adapter._overlay_artist_group_norm(artist) or "unknown"
        artist_keys = {_production_source_key(
            "artists", "all", artist_group_key,
        )}
        canonical_artist_group = (
            "unknown"
            if adapter._unknown_artist_name(artist)
            else adapter._source_song_owner_norm(artist)
        )
        canonical_song_group = "\x1f".join((
            adapter._source_song_owner_norm(title),
            canonical_artist_group,
        ))
        if source_scope is not None:
            song_keys.update(source_scope.source_keys_for_group(
                "songs", canonical_song_group,
            ))
            artist_keys.update(source_scope.source_keys_for_group(
                "artists", artist_group_key,
            ))
        for source_key in (*song_keys, *artist_keys):
            if source_key in requested_keys:
                pairs.update((source_key, video_id) for video_id in videos)
                targets.add((
                    "songs" if source_key in song_keys else "artists",
                    canonical_song_group
                    if source_key in song_keys else artist_group_key,
                    source_key,
                ))
    for channel_key in {_text(value) for value in channel_keys if _text(value)}:
        source_keys = {_production_source_key("vtubers", "all", channel_key)}
        if source_scope is not None:
            source_keys.update(source_scope.source_keys_for_group(
                "vtubers", channel_key,
            ))
        for source_key in source_keys:
            if source_key in requested_keys:
                pairs.update((source_key, video_id) for video_id in videos)
                targets.add(("vtubers", channel_key, source_key))
    return pairs, targets


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
                adapter._source_song_owner_norm(row.get("title")),
                "unknown"
                if adapter._unknown_artist_name(row.get("artist"))
                else adapter._source_song_owner_norm(row.get("artist")),
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

    # Artist cards retain reviewed aliases that are not derivable from the raw
    # overlay spelling.  Stage every parent Artist identity on disk, then use
    # exact canonical keys before alias fallbacks.  Filtering to requested
    # source keys happens only after global ownership is known, so an alias
    # that is also another card's canonical key can never leak to the broader
    # requested source.
    artist_identity_buffer: list[tuple[str, int, str]] = []
    for row in _stream_pg_rows(
        connection,
        "artist_owners",
        """
        SELECT detail_key,
               coalesce(payload_json::jsonb->>'sourceDetailKey','') AS source_key,
               coalesce(payload_json::jsonb->'aliases','[]'::jsonb) AS aliases
        FROM runtime_ranking_rows
        WHERE revision_id = %s AND range_id = 'all'
          AND view = 'artists' AND metric = 'count' AND scope_key = 'all'
        ORDER BY detail_key
        LIMIT %s
        """,
        [parent_revision_id, MAX_SOURCE_SCOPE_ROWS + 1],
    ):
        canonical_key = _text(row.get("detail_key"))
        source_key = _text(row.get("source_key")) or (
            _production_source_key("artists", "all", canonical_key)
            if canonical_key else ""
        )
        aliases = row.get("aliases")
        if isinstance(aliases, str):
            try:
                aliases = json.loads(aliases)
            except json.JSONDecodeError as exc:
                raise RuntimeError(
                    "snapshot Artist alias payload is invalid"
                ) from exc
        if not canonical_key or not source_key or not isinstance(aliases, list):
            raise RuntimeError("snapshot Artist alias payload is invalid")
        artist_identity_buffer.append((canonical_key, 0, source_key))
        for alias in aliases:
            if not isinstance(alias, Mapping) or not _text(alias.get("key")):
                raise RuntimeError("snapshot Artist alias payload is invalid")
            artist_identity_buffer.append((
                _text(alias.get("key")), 1, source_key,
            ))
        if len(artist_identity_buffer) >= SOURCE_SCOPE_FETCH_SIZE:
            scope.add_artist_identities(artist_identity_buffer)
            artist_identity_buffer = []
    scope.add_artist_identities(artist_identity_buffer)
    identity_count = int(scope.connection.execute(
        "SELECT count(*) FROM source_scope_artist_identities"
    ).fetchone()[0])
    if identity_count > MAX_SOURCE_SCOPE_ROWS:
        raise RuntimeError("snapshot Artist alias scope exceeded identity cap")
    scope.finalize_artist_targets(requested)
    artist_identity_buffer = []
    aliases = None
    row = None
    _release_source_scope_stage("artist_owners")

    pair_buffer: list[tuple[str, str]] = []
    derived_target_buffer: list[tuple[str, str, str]] = []
    video_buffer: list[str] = []

    def flush() -> None:
        nonlocal pair_buffer, derived_target_buffer, video_buffer
        if video_buffer:
            scope.add_videos(video_buffer)
            video_buffer = []
        if pair_buffer:
            scope.add_pairs(pair_buffer)
            pair_buffer = []
        if derived_target_buffer:
            scope.add_targets(derived_target_buffer)
            derived_target_buffer = []

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
        derived_pairs, derived_targets = _derived_source_pairs(
            video_ids=(video_id,),
            channel_keys=(channel_key,),
            requested_keys=requested,
            source_scope=scope,
        )
        pair_buffer.extend(derived_pairs)
        derived_target_buffer.extend(derived_targets)
        if (
            len(video_buffer) + len(pair_buffer) + len(derived_target_buffer)
            >= SOURCE_SCOPE_FETCH_SIZE
        ):
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
        derived_pairs, derived_targets = _derived_source_pairs(
            video_ids=(video_id,),
            song_pairs=((title, artist),) if title else (),
            requested_keys=requested,
            source_scope=scope,
        )
        pair_buffer.extend(derived_pairs)
        derived_target_buffer.extend(derived_targets)
        if (
            len(video_buffer) + len(pair_buffer) + len(derived_target_buffer)
            >= SOURCE_SCOPE_FETCH_SIZE
        ):
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
        derived_pairs, derived_targets = _derived_source_pairs(
            video_ids=(video_id,),
            song_pairs=((title, artist),) if title else (),
            channel_keys=(channel_key,),
            requested_keys=requested,
            source_scope=scope,
        )
        pair_buffer.extend(derived_pairs)
        derived_target_buffer.extend(derived_targets)
        if (
            len(video_buffer) + len(pair_buffer) + len(derived_target_buffer)
            >= SOURCE_SCOPE_FETCH_SIZE
        ):
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
        derived_pairs, derived_targets = _derived_source_pairs(
            video_ids=videos,
            song_pairs=songs,
            channel_keys=channels,
            requested_keys=requested,
            source_scope=scope,
        )
        pair_buffer.extend(derived_pairs)
        derived_target_buffer.extend(derived_targets)
        if (
            len(video_buffer) + len(pair_buffer) + len(derived_target_buffer)
            >= SOURCE_SCOPE_FETCH_SIZE
        ):
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
    builder: Any | None = None,
) -> None:
    """Release one prepared ranking aggregate before building the next one."""

    # Snapshot combinations are strictly serial and immutable.  Online cache
    # reuse is useful for concurrent page requests, but retaining a prior
    # VTuber scope's nested canonical-song payload while constructing the next
    # scope can exceed the isolated 700 MiB builder limit.  Drop only the two
    # recomputable payload caches here; the builder's small scalar/source
    # authority caches remain available for the rest of the snapshot.
    if view == "vtubers":
        # This list contains one mutable dictionary per persisted reset
        # occurrence.  Preparation enriches those dictionaries with
        # scope-specific group counts and channel evidence.  Retaining the
        # enriched list across the next scope both raises the baseline by
        # hundreds of MiB and lets per-scope fields accumulate.  Rebuild the
        # bounded list for the next scope; keep the tiny verified physical
        # source-total cache on the builder.
        reset_cache = getattr(builder, "snapshot_reset_changes", None)
        if isinstance(reset_cache, dict):
            reset_cache.clear()
        reconciliation_cache = getattr(builder, "reconciliation_counts", None)
        if isinstance(reconciliation_cache, dict):
            reconciliation_cache.clear()
        for cache_name, lock_name in (
            ("_VTUBER_REPLACEMENT_CACHE", "_VTUBER_REPLACEMENT_CACHE_LOCK"),
            (
                "_GENERIC_RANKING_PREPARATION_CACHE",
                "_GENERIC_RANKING_PREPARATION_LOCK",
            ),
        ):
            cache = getattr(adapter, cache_name, None)
            lock = getattr(adapter, lock_name, None)
            clear = getattr(cache, "clear", None)
            if not callable(clear):
                continue
            if lock is None:
                clear()
            else:
                with lock:
                    clear()
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


def _release_completed_ranking_view_memory(
    builder: Any,
    *,
    range_id: str,
    view: str,
) -> None:
    """Drop caches whose keys cannot be read by a later ranking view.

    The materializer's loop is ordered by range and view.  Reset parent rows,
    group counts and reconciliation scalars are all keyed by view or derived
    specifically for it; once its twelve metric/scope combinations finish,
    retaining those nested dictionaries only increases the baseline for the
    next view.  VTuber physical source totals are range-specific but reused
    across every VTuber metric, so keep them until that view is complete too.
    """

    for name in (
        "reconciliation_counts",
        "snapshot_reset_changes",
        "snapshot_original_group_counts",
    ):
        cache = getattr(builder, name, None)
        if isinstance(cache, dict):
            cache.clear()
    if view == "artists":
        for name in (
            "snapshot_artist_aliases",
            "snapshot_artist_source_totals",
        ):
            cache = getattr(builder, name, None)
            if isinstance(cache, dict):
                cache.clear()
    if view == "vtubers":
        cache = getattr(builder, "snapshot_vtuber_source_totals", None)
        if isinstance(cache, dict):
            cache.clear()
    for cache_name, lock_name in (
        ("_VTUBER_REPLACEMENT_CACHE", "_VTUBER_REPLACEMENT_CACHE_LOCK"),
        (
            "_GENERIC_RANKING_PREPARATION_CACHE",
            "_GENERIC_RANKING_PREPARATION_LOCK",
        ),
    ):
        cache = getattr(adapter, cache_name, None)
        lock = getattr(adapter, lock_name, None)
        clear = getattr(cache, "clear", None)
        if not callable(clear):
            continue
        if lock is None:
            clear()
        else:
            with lock:
                clear()
    trimmed = _trim_process_heap()
    print(
        f"PG_SNAPSHOT_VIEW_RELEASE range={range_id} view={view} "
        f"rss_kib={_current_rss_kib()} swap_kib={_current_swap_kib()} "
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
        "snapshot_artist_aliases",
        "snapshot_artist_source_totals",
    ):
        cache = getattr(builder, name, None)
        if isinstance(cache, dict):
            cache.clear()
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


def _legacy_ranking_song_count(
    record: Mapping[str, Any], view: str,
) -> int:
    """Recover one missing legacy scalar from the canonical card payload."""

    if view == "songs":
        if not _text(record.get("key") or record.get("title")):
            raise RuntimeError("legacy song ranking has no canonical identity")
        return 1
    songs = record.get("songs")
    if not isinstance(songs, list) or not songs:
        raise RuntimeError(
            f"legacy {view} ranking has no canonical songs payload"
        )
    if view == "artists":
        identities: set[str] = set()
        for raw in songs:
            if not isinstance(raw, Mapping):
                raise RuntimeError("legacy Artist song entry is invalid")
            identity = _text(
                raw.get("key") or raw.get("name") or raw.get("title")
            )
            if not identity or identity in identities:
                raise RuntimeError(
                    "legacy Artist canonical song identities are invalid"
                )
            if raw.get("count") is not None and _integer(raw.get("count")) <= 0:
                raise RuntimeError("legacy Artist song count is invalid")
            identities.add(identity)
        return len(identities)
    if view == "videos":
        identities: set[str] = set()
        for raw in songs:
            if not isinstance(raw, Mapping):
                raise RuntimeError("legacy video song entry is invalid")
            nested = raw.get("song")
            song = dict(nested) if isinstance(nested, Mapping) else dict(raw)
            explicit_key = _text(song.get("songKey") or song.get("key"))
            if explicit_key:
                song["songKey"] = explicit_key
            title = _text(song.get("title") or raw.get("songTitle"))
            artist = _text(song.get("artist") or raw.get("songArtist"))
            if title:
                song["title"] = title
                song["artist"] = artist
            if not explicit_key and not title:
                raise RuntimeError("legacy video song identity is invalid")
            identity = adapter._song_key(song)
            if not identity:
                raise RuntimeError("legacy video canonical song key is empty")
            identities.add(identity)
        return len(identities)
    raise RuntimeError(f"legacy {view} songCount cannot be reconstructed")


def _complete_ranking_metric_scalars(
    record: Mapping[str, Any], view: str,
) -> dict[str, Any]:
    """Normalize one canonical card before it becomes the shared metric row."""

    result = dict(record)
    count = _integer(result.get("count") or result.get("timestampCount"))
    song_count = _integer(result.get("songCount"))
    if song_count <= 0:
        song_count = _legacy_ranking_song_count(result, view)
    video_count = _integer(result.get("videoCount"))
    timestamp_count = _integer(result.get("timestampCount") or count)
    if min(count, song_count, video_count, timestamp_count) <= 0:
        raise RuntimeError(
            f"canonical ranking scalars are not positive: {view}"
        )
    result.update({
        "count": count,
        "songCount": song_count,
        "videoCount": video_count,
        "timestampCount": timestamp_count,
    })
    return result


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
        self.connection = sqlite3.connect(
            self.temp,
            timeout=SQLITE_BUSY_TIMEOUT_MS / 1000,
        )
        self.connection.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS}")
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
        # A VTuber ranking card can carry a stale songCount scalar even when
        # its persisted source occurrence stream has the authoritative
        # canonical-key cardinality.  Corrections are staged here while the
        # source stream is scanned and applied to the already-written static
        # ranking pages after the pass completes.
        self.static_ranking_root: Path | None = None
        self.song_count_corrections: dict[tuple[str, str], int] = {}

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

    def ranking_series_totals(
        self,
        *,
        range_id: str,
        view: str,
        metric: str,
        scope_key: str,
    ) -> dict[str, int]:
        row = self.connection.execute(
            """
            SELECT count(*),coalesce(sum(count),0),
                   coalesce(sum(song_count),0),coalesce(sum(video_count),0)
            FROM ranking_rows
            WHERE range_id=? AND view=? AND metric=? AND scope_key=?
            """,
            (range_id, view, metric, scope_key),
        ).fetchone()
        return {
            "totalCount": int(row[0] or 0),
            "totalOccurrenceCount": int(row[1] or 0),
            "totalSongCount": int(row[2] or 0),
            "totalVideoCount": int(row[3] or 0),
        }

    def ranking_metric_pages(
        self,
        *,
        range_id: str,
        view: str,
        metric: str,
        scope_key: str,
        page_size: int,
    ) -> Iterable[tuple[int, tuple[dict[str, Any], ...]]]:
        """Stream one stored metric in rank order without retaining pages."""

        if page_size <= 0:
            raise ValueError("ranking page size must be positive")
        total, minimum_rank, maximum_rank, distinct_ranks = (
            self.connection.execute(
                """
                SELECT count(*),min(rank),max(rank),count(DISTINCT rank)
                FROM ranking_rows
                WHERE range_id=? AND view=? AND metric=? AND scope_key=?
                """,
                (range_id, view, metric, scope_key),
            ).fetchone()
        )
        total = int(total or 0)
        if total == 0:
            yield 1, ()
            return
        if (
            int(minimum_rank or 0) != 1
            or int(maximum_rank or 0) != total
            or int(distinct_ranks or 0) != total
        ):
            raise RuntimeError("stored ranking ranks are not contiguous")
        for start in range(1, total + 1, page_size):
            rows = self.connection.execute(
                """
                SELECT rank,payload_json
                FROM ranking_rows
                WHERE range_id=? AND view=? AND metric=? AND scope_key=?
                  AND rank BETWEEN ? AND ?
                ORDER BY rank
                """,
                (
                    range_id,
                    view,
                    metric,
                    scope_key,
                    start,
                    min(total, start + page_size - 1),
                ),
            ).fetchall()
            expected = list(
                range(start, min(total, start + page_size - 1) + 1)
            )
            if [int(row[0]) for row in rows] != expected:
                raise RuntimeError("stored ranking page is incomplete")
            records: list[dict[str, Any]] = []
            for rank, payload_json in rows:
                try:
                    payload = json.loads(payload_json)
                except (TypeError, json.JSONDecodeError) as exc:
                    raise RuntimeError("stored ranking payload is invalid") from exc
                if (
                    not isinstance(payload, dict)
                    or _integer(payload.get("rank")) != int(rank)
                ):
                    raise RuntimeError("stored ranking payload rank is invalid")
                records.append(payload)
            yield (start - 1) // page_size + 1, tuple(records)

    def derive_ranking_metric_pages(
        self,
        *,
        range_id: str,
        view: str,
        scope_key: str,
        source_metric: str,
        target_metric: str,
        page_size: int,
    ) -> Iterable[tuple[int, tuple[dict[str, Any], ...]]]:
        """Re-rank one immutable entity set without rehydrating PostgreSQL.

        Snapshot ranking queries always use ``minCount=1``.  A positive
        canonical row therefore belongs to all three metric series; only its
        ordering changes.  Reuse the already-validated compact payload and
        deep search text from the first series, update its public rank, and
        insert the target series in bounded page batches.  Any zero scalar or
        identity mismatch fails closed instead of silently deriving a series
        with different membership.
        """

        if source_metric == target_metric:
            raise ValueError("derived ranking metrics must differ")
        if source_metric not in {"count", "songs", "videos"}:
            raise ValueError("unsupported source ranking metric")
        if target_metric not in {"count", "songs", "videos"}:
            raise ValueError("unsupported target ranking metric")
        if page_size <= 0:
            raise ValueError("derived ranking page size must be positive")

        total, minimum_count, minimum_songs, minimum_videos = (
            self.connection.execute(
                """
                SELECT count(*),min(count),min(song_count),min(video_count)
                FROM ranking_rows
                WHERE range_id=? AND view=? AND metric=? AND scope_key=?
                """,
                (range_id, view, source_metric, scope_key),
            ).fetchone()
        )
        total = int(total or 0)
        if total == 0:
            # Empty filtered scopes are part of the declared 96-series
            # contract even though they have no physical ranking rows.
            yield 1, ()
            return
        if min(
            int(minimum_count or 0),
            int(minimum_videos or 0),
        ) <= 0 or (
            view != "vtubers" and int(minimum_songs or 0) <= 0
        ):
            raise RuntimeError(
                "ranking metric membership is not invariant at minCount=1"
            )
        existing = int(
            self.connection.execute(
                """
                SELECT count(*) FROM ranking_rows
                WHERE range_id=? AND view=? AND metric=? AND scope_key=?
                """,
                (range_id, view, target_metric, scope_key),
            ).fetchone()[0]
        )
        if existing:
            raise RuntimeError("derived ranking metric already exists")

        order_index = {
            "count": 5,
            "songs": 6,
            "videos": 7,
        }[target_metric]
        source_order_rows = self.connection.execute(
            """
            SELECT rank,row_id,title,name,detail_key,
                   count,song_count,video_count
            FROM ranking_rows
            WHERE range_id=? AND view=? AND metric=? AND scope_key=?
            """,
            (range_id, view, source_metric, scope_key),
        ).fetchall()
        entity_keys: dict[int, str] = {}
        for row in source_order_rows:
            source_rank = int(row[0])
            expected_prefix = ":".join((
                range_id,
                view,
                source_metric,
                scope_key,
                str(source_rank),
                "",
            ))
            row_id = _text(row[1])
            if not row_id.startswith(expected_prefix):
                raise RuntimeError("derived ranking row identity is invalid")
            entity_key = row_id[len(expected_prefix) :]
            if not entity_key:
                raise RuntimeError("derived ranking entity identity is empty")
            if source_rank in entity_keys:
                raise RuntimeError("derived ranking source rank is duplicated")
            entity_keys[source_rank] = entity_key
        source_order_rows.sort(key=lambda row: (
            -int(row[order_index] or 0),
            _text(row[2] or row[3] or entity_keys[int(row[0])] or row[4]),
            entity_keys[int(row[0])],
        ))
        source_ranks = [int(row[0]) for row in source_order_rows]
        if len(source_ranks) != total or len(set(source_ranks)) != total:
            raise RuntimeError("derived ranking source order is invalid")

        columns = (
            "row_id,range_id,view,metric,scope_key,rank,detail_key,title,"
            "artist,name,count,song_count,video_count,timestamp_count,"
            "payload_json,search_text,channel_search_text"
        )
        for start in range(0, total, page_size):
            selected_ranks = source_ranks[start : start + page_size]
            placeholders = ",".join("?" for _ in selected_ranks)
            source_rows = self.connection.execute(
                f"""
                SELECT {columns}
                FROM ranking_rows
                WHERE range_id=? AND view=? AND metric=? AND scope_key=?
                  AND rank IN ({placeholders})
                """,
                (
                    range_id,
                    view,
                    source_metric,
                    scope_key,
                    *selected_ranks,
                ),
            ).fetchall()
            by_rank = {int(row[5]): row for row in source_rows}
            if set(by_rank) != set(selected_ranks):
                raise RuntimeError("derived ranking source page is incomplete")

            records: list[dict[str, Any]] = []
            for offset, source_rank in enumerate(selected_ranks, start=start + 1):
                row = by_rank[source_rank]
                expected_prefix = ":".join(
                    (
                        range_id,
                        view,
                        source_metric,
                        scope_key,
                        str(source_rank),
                        "",
                    )
                )
                row_id = _text(row[0])
                if not row_id.startswith(expected_prefix):
                    raise RuntimeError("derived ranking row identity is invalid")
                entity_key = entity_keys[source_rank]
                if row_id != expected_prefix + entity_key:
                    raise RuntimeError("derived ranking entity identity changed")
                try:
                    payload = json.loads(row[14])
                except (TypeError, json.JSONDecodeError) as exc:
                    raise RuntimeError(
                        "derived ranking payload is invalid"
                    ) from exc
                if not isinstance(payload, dict):
                    raise RuntimeError("derived ranking payload is not an object")
                if _integer(payload.get("rank")) != source_rank:
                    raise RuntimeError("derived ranking payload rank is invalid")
                payload["rank"] = offset
                target_row_id = ":".join(
                    (
                        range_id,
                        view,
                        target_metric,
                        scope_key,
                        str(offset),
                        entity_key,
                    )
                )
                self.add_ranking((
                    target_row_id,
                    range_id,
                    view,
                    target_metric,
                    scope_key,
                    offset,
                    *row[6:14],
                    _json_text(payload),
                    row[15],
                    row[16],
                ))
                records.append(payload)
            yield start // page_size + 1, tuple(records)

    def derive_filtered_ranking_scopes(
        self,
        *,
        range_id: str,
        page_size: int,
    ) -> dict[str, int]:
        """Derive all filtered rankings from exported canonical sources.

        Legacy PostgreSQL releases do not contain a complete persisted row set
        for every filtered scope.  The source-detail occurrence stream is the
        canonical membership authority, so scan it once for the requested
        range, compute all three filters together, stage compact count cards in
        temporary SQLite tables, and then reuse the metric re-ranker above.
        The all-scope card scalars are checked against the same occurrence set
        before any filtered rows are made visible.
        """

        if range_id not in RANGES:
            raise ValueError("unsupported filtered ranking range")
        if page_size <= 0:
            raise ValueError("filtered ranking page size must be positive")
        filtered_scopes = tuple(
            scope_key for scope_key, _niche, _hidden in SCOPES
            if scope_key != "all"
        )
        if filtered_scopes != ("niche", "visible", "visibleNiche"):
            raise RuntimeError("filtered ranking scope contract changed")

        base_table = "temp.filtered_ranking_base"
        candidate_table = "temp.filtered_ranking_candidates"
        self.connection.execute(f"DROP TABLE IF EXISTS {candidate_table}")
        self.connection.execute(f"DROP TABLE IF EXISTS {base_table}")
        self.connection.executescript(f"""
        CREATE TEMP TABLE filtered_ranking_base(
          source_key TEXT PRIMARY KEY,view TEXT NOT NULL,entity_key TEXT NOT NULL,
          title TEXT NOT NULL,artist TEXT NOT NULL,name TEXT NOT NULL,
          count INTEGER NOT NULL,song_count INTEGER NOT NULL,
          video_count INTEGER NOT NULL,timestamp_count INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TEMP TABLE filtered_ranking_candidates(
          view TEXT NOT NULL,scope_key TEXT NOT NULL,entity_key TEXT NOT NULL,
          source_key TEXT NOT NULL,title TEXT NOT NULL,artist TEXT NOT NULL,
          name TEXT NOT NULL,count INTEGER NOT NULL,song_count INTEGER NOT NULL,
          video_count INTEGER NOT NULL,timestamp_count INTEGER NOT NULL,
          payload_json TEXT NOT NULL,search_text TEXT NOT NULL,
          channel_search_text TEXT NOT NULL,
          PRIMARY KEY(view,scope_key,source_key)
        ) WITHOUT ROWID;
        """)

        def parse_payload(raw: Any, context: str) -> dict[str, Any]:
            try:
                payload = json.loads(raw)
            except (TypeError, json.JSONDecodeError) as exc:
                raise RuntimeError(f"{context} payload is invalid") from exc
            if not isinstance(payload, dict):
                raise RuntimeError(f"{context} payload is not an object")
            return payload

        def count_items(values: Mapping[str, list[Any]]) -> list[dict[str, Any]]:
            return [
                {"key": key, "name": _text(value[0]) or key, "count": int(value[1])}
                for key, value in sorted(
                    values.items(),
                    key=lambda item: (-int(item[1][1]), _text(item[1][0]), item[0]),
                )
            ]

        def artist_items(values: Mapping[str, int]) -> list[dict[str, Any]]:
            return [
                {"name": name, "count": int(count)}
                for name, count in sorted(
                    values.items(), key=lambda item: (-int(item[1]), item[0])
                )
            ]

        def authoritative_song_names(
            payload: Mapping[str, Any],
            *,
            view: str,
            entity_key: str,
            title: str,
        ) -> tuple[dict[str, str], set[str]]:
            """Return keyed and unkeyed all-scope canonical display names.

            Source occurrences can contain reviewed title variants which share
            one canonical key (for example a VTuber version marker or a legacy
            artist occurrence retaining an older spelling).  The all-scope
            card is built from the same effective occurrence set.  Song and
            video cards normally retain a key, while artist/VTuber cards use
            the public count-list shape (name/count only).  Keep both forms:
            filtered cards must use the keyed pair when present, or resolve a
            variant against the authoritative name set instead of treating it
            as a new identity.
            """

            names: dict[str, str] = {}
            values: set[str] = set()
            raw_songs = payload.get("songs")
            if isinstance(raw_songs, list):
                for raw_song in raw_songs:
                    if not isinstance(raw_song, Mapping):
                        raise RuntimeError(
                            "all-scope ranking canonical song entry is invalid"
                        )
                    nested_song = raw_song.get("song")
                    nested_song = (
                        nested_song if isinstance(nested_song, Mapping) else {}
                    )
                    song_key = _text(
                        raw_song.get("key")
                        or raw_song.get("songKey")
                        or nested_song.get("key")
                        or nested_song.get("songKey")
                    )
                    song_name = _text(
                        raw_song.get("name")
                        or raw_song.get("title")
                        or raw_song.get("workTitle")
                        or nested_song.get("name")
                        or nested_song.get("title")
                        or nested_song.get("workTitle")
                    )
                    if not song_name:
                        raise RuntimeError(
                            "all-scope ranking canonical song identity is incomplete"
                        )
                    values.add(song_name)
                    if not song_key:
                        continue
                    previous = names.get(song_key)
                    if (
                        previous is not None
                        and _canonical_song_name_key(previous)
                        != _canonical_song_name_key(song_name)
                    ):
                        raise RuntimeError(
                            "all-scope ranking canonical song name changed: "
                            f"{song_key}"
                        )
                    names[song_key] = song_name
            if view == "songs" and entity_key and title:
                names.setdefault(entity_key, title)
                values.add(title)
            return names, values

        def new_scope_state(
            base: Mapping[str, Any],
        ) -> dict[str, Any]:
            search = _BoundedTextAccumulator(MAX_RANKING_SEARCH_CHARS)
            channel_search = _BoundedTextAccumulator(MAX_CHANNEL_SEARCH_CHARS)
            payload = base["payload"]
            for value in (
                base["entity_key"], base["source_key"], base["title"],
                base["artist"], base["name"], payload.get("key"),
                payload.get("videoId"), payload.get("title"),
                payload.get("workTitle"), payload.get("displayArtist"),
                payload.get("artist"), payload.get("name"),
                payload.get("channelName"), payload.get("channelId"),
                payload.get("channelHandle"), payload.get("channelUrl"),
            ):
                search.add(value)
            for value in (
                payload.get("channelName"), payload.get("channelId"),
                payload.get("channelHandle"), payload.get("channelUrl"),
            ):
                channel_search.add(value)
            return {
                "count": 0,
                "videos": set(),
                "songs": {},
                "artists": {},
                "previews": [],
                "preview_videos": set(),
                "video_songs": [],
                "video_song_keys": set(),
                "search": search,
                "channel_search": channel_search,
            }

        base_counts = {view: 0 for view in VIEWS}
        base_rows = self.connection.execute(
            """
            SELECT view,rank,row_id,detail_key,title,artist,name,count,
                   song_count,video_count,timestamp_count,payload_json
            FROM ranking_rows
            WHERE range_id=? AND metric='count' AND scope_key='all'
            ORDER BY view,rank
            """,
            (range_id,),
        )
        pending_base: list[tuple[Any, ...]] = []
        for row in base_rows:
            view = _text(row[0])
            rank = int(row[1] or 0)
            source_key = _text(row[3])
            if view not in VIEWS or rank <= 0 or not source_key:
                raise RuntimeError(
                    "all-scope ranking source identity is invalid: "
                    f"range={range_id!r} view={view!r} rank={rank} "
                    f"rowId={_text(row[2])!r} sourceKey={source_key!r}"
                )
            prefix = ":".join((range_id, view, "count", "all", str(rank), ""))
            row_id = _text(row[2])
            if not row_id.startswith(prefix):
                raise RuntimeError("all-scope ranking row identity is invalid")
            entity_key = row_id[len(prefix) :]
            if not entity_key:
                raise RuntimeError("all-scope ranking entity identity is empty")
            payload = parse_payload(row[11], "all-scope ranking")
            if _text(payload.get("sourceDetailKey")) != source_key:
                raise RuntimeError("all-scope ranking source key changed")
            pending_base.append((
                source_key, view, entity_key, _text(row[4]), _text(row[5]),
                _text(row[6]), int(row[7] or 0), int(row[8] or 0),
                int(row[9] or 0), int(row[10] or 0), _json_text(payload),
            ))
            base_counts[view] += 1
            if len(pending_base) >= 512:
                self.connection.executemany(
                    "INSERT INTO filtered_ranking_base VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    pending_base,
                )
                pending_base.clear()
        if pending_base:
            self.connection.executemany(
                "INSERT INTO filtered_ranking_base VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                pending_base,
            )
            pending_base.clear()
        if any(base_counts[view] <= 0 for view in VIEWS):
            raise RuntimeError(f"all-scope ranking view is empty: {range_id}")
        missing_details = int(self.connection.execute(
            """
            SELECT count(*) FROM filtered_ranking_base AS base
            LEFT JOIN source_details AS detail
              ON detail.source_key=base.source_key AND detail.range_id=?
            WHERE detail.source_key IS NULL
            """,
            (range_id,),
        ).fetchone()[0])
        if missing_details:
            raise RuntimeError(
                f"all-scope ranking sources are missing details: {range_id}/{missing_details}"
            )

        pending_candidates: list[tuple[Any, ...]] = []
        seen_sources: set[str] = set()
        current_source = ""
        current_base: dict[str, Any] | None = None
        all_count = 0
        all_videos: set[str] = set()
        all_songs: set[str] = set()
        states: dict[str, dict[str, Any]] = {}
        expected_position = 0

        def flush_candidates() -> None:
            if not pending_candidates:
                return
            self.connection.executemany(
                "INSERT INTO filtered_ranking_candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                pending_candidates,
            )
            pending_candidates.clear()

        def finish_source() -> None:
            nonlocal all_count
            nonlocal all_videos
            nonlocal all_songs
            nonlocal states
            nonlocal current_base
            if current_base is None:
                return
            expected = (
                int(current_base["count"]), int(current_base["song_count"]),
                int(current_base["video_count"]),
                int(current_base["timestamp_count"]),
            )
            actual = (all_count, len(all_songs), len(all_videos), all_count)
            if actual != expected:
                view = _text(current_base["view"])
                if (
                    view == "vtubers"
                    and actual[0] == expected[0]
                    and actual[2] == expected[2]
                    and actual[3] == expected[3]
                    and 0 <= actual[1] < expected[1]
                ):
                    self._reconcile_vtuber_song_count(
                        range_id=range_id,
                        source_key=_text(current_base["source_key"]),
                        ranking_song_count=expected[1],
                        source_song_count=actual[1],
                    )
                    current_base["song_count"] = actual[1]
                    current_payload = dict(current_base["payload"])
                    current_payload["songCount"] = actual[1]
                    current_base["payload"] = current_payload
                    expected = (expected[0], actual[1], expected[2], expected[3])
                else:
                    raise RuntimeError(
                        "all-scope ranking/source totals differ: "
                        f"{range_id}/{current_base['view']}/{current_base['source_key']} "
                        f"ranking={expected} source={actual}"
                    )
            for scope_key in filtered_scopes:
                state = states[scope_key]
                count = int(state["count"])
                if count <= 0:
                    continue
                payload = dict(current_base["payload"])
                for name in (
                    "occurrences", "songs", "artists", "channels", "singers",
                    "sourcePreviewCount", "songPreviewCount",
                    "occurrencePreviewLimited",
                ):
                    payload.pop(name, None)
                payload.update({
                    "rank": 0,
                    "count": count,
                    "songCount": len(state["songs"]),
                    "videoCount": len(state["videos"]),
                    "timestampCount": count,
                    "occurrences": list(state["previews"]),
                })
                view = _text(current_base["view"])
                if view == "artists":
                    payload["songs"] = count_items(state["songs"])
                elif view == "songs":
                    artists = artist_items(state["artists"])
                    if artists:
                        payload["artists"] = artists
                elif view == "videos":
                    payload["songs"] = list(state["video_songs"])
                compact = adapter.compact_ranking_payloads([payload], view)
                if len(compact) != 1 or not isinstance(compact[0], Mapping):
                    raise RuntimeError("filtered compact ranking projection is invalid")
                compact_payload = dict(compact[0])
                if _text(compact_payload.get("sourceDetailKey")) != current_base["source_key"]:
                    raise RuntimeError("filtered ranking source key changed")
                pending_candidates.append((
                    view, scope_key, current_base["entity_key"],
                    current_base["source_key"], current_base["title"],
                    current_base["artist"], current_base["name"], count,
                    len(state["songs"]), len(state["videos"]), count,
                    _json_text(compact_payload), state["search"].text,
                    state["channel_search"].text,
                ))
            if len(pending_candidates) >= 512:
                flush_candidates()
            all_count = 0
            all_videos = set()
            all_songs = set()
            states = {}
            current_base = None

        occurrence_rows = self.connection.execute(
            """
            SELECT base.source_key,base.view,base.entity_key,base.title,
                   base.artist,base.name,base.count,base.song_count,
                   base.video_count,base.timestamp_count,base.payload_json,
                   occurrence.position,occurrence.video_id,occurrence.title,
                   occurrence.channel_name,occurrence.channel_id,
                   occurrence.channel_handle,occurrence.channel_url,
                   occurrence.published_timestamp,occurrence.seconds,
                   occurrence.is_niche,occurrence.is_unknown_artist,
                   occurrence.canonical_song_key,
                   occurrence.canonical_song_name,occurrence.search_text,
                   occurrence.payload_json
            FROM filtered_ranking_base AS base
            JOIN source_occurrences AS occurrence
              ON occurrence.source_key=base.source_key
             AND occurrence.range_id=?
            ORDER BY base.source_key,occurrence.position
            """,
            (range_id,),
        )
        for row in occurrence_rows:
            source_key = _text(row[0])
            if source_key != current_source:
                finish_source()
                if source_key in seen_sources:
                    raise RuntimeError("filtered source occurrence order is unstable")
                seen_sources.add(source_key)
                current_source = source_key
                current_base = {
                    "source_key": source_key,
                    "view": _text(row[1]),
                    "entity_key": _text(row[2]),
                    "title": _text(row[3]),
                    "artist": _text(row[4]),
                    "name": _text(row[5]),
                    "count": int(row[6] or 0),
                    "song_count": int(row[7] or 0),
                    "video_count": int(row[8] or 0),
                    "timestamp_count": int(row[9] or 0),
                    "payload": parse_payload(row[10], "all-scope ranking"),
                }
                (
                    current_base["song_names"],
                    current_base["song_name_values"],
                ) = authoritative_song_names(
                    current_base["payload"],
                    view=current_base["view"],
                    entity_key=current_base["entity_key"],
                    title=current_base["title"],
                )
                states = {
                    scope_key: new_scope_state(current_base)
                    for scope_key in filtered_scopes
                }
                all_count = 0
                all_videos = set()
                all_songs = set()
                expected_position = 0
            expected_position += 1
            if int(row[11] or 0) != expected_position:
                raise RuntimeError(
                    f"source occurrence positions are not contiguous: {range_id}/{source_key}"
                )
            video_id = _text(row[12])
            song_key = _text(row[22])
            occurrence_song_name = _text(row[23])
            raw_payload = parse_payload(row[25], "source occurrence")
            raw_song = raw_payload.get("song")
            raw_song = dict(raw_song) if isinstance(raw_song, Mapping) else {}
            raw_song_title = _text(
                raw_song.get("title")
                or raw_payload.get("songTitle")
            )
            unkeyed_vtuber_song = False
            titleless_vtuber_video = False
            if _text(current_base.get("view")) == "vtubers":
                if raw_song_title:
                    _canonical_title, canonical_key = adapter._vtuber_canonical_song_identity(
                        raw_song_title
                    )
                    unkeyed_vtuber_song = not canonical_key
                else:
                    titleless_vtuber_video = bool(
                        video_id and not song_key and not occurrence_song_name
                    )
            if not occurrence_song_name and song_key:
                occurrence_song_name = _text(
                    current_base["song_names"].get(song_key)
                )
            if not video_id or (
                (not song_key or not occurrence_song_name)
                and not (unkeyed_vtuber_song or titleless_vtuber_video)
            ):
                raise RuntimeError(
                    f"source occurrence identity is incomplete: {range_id}/{source_key}"
                )
            if unkeyed_vtuber_song or titleless_vtuber_video:
                occurrence_song_name = occurrence_song_name or raw_song_title
            song_name = _text(current_base["song_names"].get(song_key))
            if not song_name:
                song_name = occurrence_song_name
                existing_state = None
                for scope_key in filtered_scopes:
                    existing = states.get(scope_key, {}).get("songs", {}).get(song_key)
                    if existing is not None:
                        existing_state = _text(existing[0])
                        break
                if existing_state:
                    if (
                        _canonical_song_name_key(existing_state)
                        == _canonical_song_name_key(occurrence_song_name)
                    ):
                        song_name = existing_state
                    else:
                        authoritative_values = current_base["song_name_values"]
                        candidates = {
                            value for value in (existing_state, occurrence_song_name)
                            if value in authoritative_values
                        }
                        if len(candidates) != 1:
                            raise RuntimeError(
                                "canonical song name changed inside one source: "
                                f"{range_id}/{current_source} songKey={song_key} "
                                f"first={existing_state!r} next={occurrence_song_name!r}"
                            )
                        song_name = next(iter(candidates))
            all_count += 1
            all_videos.add(video_id)
            if song_key:
                all_songs.add(song_key)
            is_niche = bool(row[20])
            is_unknown = bool(row[21])
            matched_scopes = []
            if is_niche:
                matched_scopes.append("niche")
            if not is_unknown:
                matched_scopes.append("visible")
                if is_niche:
                    matched_scopes.append("visibleNiche")
            if not matched_scopes:
                continue
            preview = adapter._normalize_ranking_preview_occurrence(raw_payload)
            if not _text(adapter._ranking_preview_video_id(preview)):
                preview["videoId"] = video_id
            raw_song = raw_payload.get("song")
            raw_song = dict(raw_song) if isinstance(raw_song, Mapping) else {}
            raw_song.setdefault("songKey", song_key)
            raw_song.setdefault("key", song_key)
            raw_song.setdefault("title", song_name)
            artist_name = _text(
                raw_song.get("artist")
                or raw_payload.get("artist")
                or raw_payload.get("songArtist")
            )
            for scope_key in matched_scopes:
                state = states[scope_key]
                state["count"] += 1
                state["videos"].add(video_id)
                if song_key:
                    song_state = state["songs"].setdefault(song_key, [song_name, 0])
                    if (
                        _canonical_song_name_key(song_state[0])
                        != _canonical_song_name_key(song_name)
                    ):
                        raise RuntimeError(
                            "canonical song name changed inside one source: "
                            f"{range_id}/{current_source} songKey={song_key} "
                            f"first={_text(song_state[0])!r} next={_text(song_name)!r}"
                        )
                    song_state[1] = int(song_state[1]) + 1
                if artist_name:
                    state["artists"][artist_name] = (
                        int(state["artists"].get(artist_name, 0)) + 1
                    )
                if (
                    video_id not in state["preview_videos"]
                    and len(state["previews"]) < 3
                ):
                    state["preview_videos"].add(video_id)
                    state["previews"].append(dict(preview))
                preview_song_key = song_key or f"unkeyed:{video_id}:{row[11]}"
                if (
                    preview_song_key not in state["video_song_keys"]
                    and len(state["video_songs"]) < 3
                ):
                    state["video_song_keys"].add(preview_song_key)
                    state["video_songs"].append(dict(raw_song))
                state["search"].add(row[24])
                for value in (row[14], row[15], row[16], row[17]):
                    state["channel_search"].add(value)
        finish_source()
        flush_candidates()
        expected_sources = sum(base_counts.values())
        if len(seen_sources) != expected_sources:
            raise RuntimeError(
                f"all-scope ranking sources have no occurrences: "
                f"{range_id} expected={expected_sources} actual={len(seen_sources)}"
            )
        self.rewrite_static_vtuber_song_counts(range_id)

        result: dict[str, int] = {}
        candidate_columns = (
            "entity_key,source_key,title,artist,name,count,song_count,"
            "video_count,timestamp_count,payload_json,search_text,"
            "channel_search_text"
        )
        try:
            for view in VIEWS:
                for scope_key in filtered_scopes:
                    cursor = self.connection.execute(
                        f"""
                        SELECT {candidate_columns}
                        FROM filtered_ranking_candidates
                        WHERE view=? AND scope_key=?
                        ORDER BY count DESC,
                          CASE WHEN title<>'' THEN title
                               WHEN name<>'' THEN name ELSE entity_key END,
                          entity_key
                        """,
                        (view, scope_key),
                    )
                    rank = 0
                    while True:
                        rows = cursor.fetchmany(256)
                        if not rows:
                            break
                        for row in rows:
                            rank += 1
                            payload = parse_payload(row[9], "filtered ranking")
                            payload["rank"] = rank
                            self.add_ranking((
                                ":".join((
                                    range_id, view, "count", scope_key,
                                    str(rank), _text(row[0]),
                                )),
                                range_id, view, "count", scope_key, rank,
                                _text(row[1]), _text(row[2]), _text(row[3]),
                                _text(row[4]), int(row[5]), int(row[6]),
                                int(row[7]), int(row[8]), _json_text(payload),
                                _text(row[10]), _text(row[11]),
                            ))
                    count_key = f"{range_id}/{view}/count/{scope_key}"
                    result[count_key] = rank
                    page_count = max(1, math.ceil(rank / page_size))
                    print(
                        f"PG_SNAPSHOT_COMBO {range_id}/{view}/occurrences/"
                        f"{scope_key} total={rank} pages={page_count}",
                        flush=True,
                    )
                    for target_metric in ("songs", "videos"):
                        derived_pages = 0
                        derived_records = 0
                        for page, records in self.derive_ranking_metric_pages(
                            range_id=range_id,
                            view=view,
                            scope_key=scope_key,
                            source_metric="count",
                            target_metric=target_metric,
                            page_size=page_size,
                        ):
                            derived_pages += 1
                            if page != derived_pages:
                                raise RuntimeError(
                                    "derived filtered ranking page order is invalid"
                                )
                            derived_records += len(records)
                        if derived_pages != page_count or derived_records != rank:
                            raise RuntimeError(
                                "derived filtered ranking series is incomplete"
                            )
                        metric_key = (
                            f"{range_id}/{view}/{target_metric}/{scope_key}"
                        )
                        result[metric_key] = rank
                        print(
                            f"PG_SNAPSHOT_COMBO {range_id}/{view}/"
                            f"{target_metric}/{scope_key} total={rank} "
                            f"pages={page_count}",
                            flush=True,
                        )
        finally:
            self.connection.execute(f"DROP TABLE IF EXISTS {candidate_table}")
            self.connection.execute(f"DROP TABLE IF EXISTS {base_table}")
        return result

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

    def _reconcile_vtuber_song_count(
        self,
        *,
        range_id: str,
        source_key: str,
        ranking_song_count: int,
        source_song_count: int,
    ) -> None:
        """Align stale VTuber card scalars with persisted source identity.

        The source occurrence stream is authoritative for canonical song
        membership.  A legacy VTuber card may still report one row per
        occurrence, so a duplicate canonical key can make its ``songCount``
        larger than the source's distinct-key count.  Only the bounded,
        source-backed VTuber case is repaired; any other mismatch remains
        fail-closed.
        """

        rows = self.connection.execute(
            """
            SELECT metric,rank,payload_json
            FROM ranking_rows
            WHERE range_id=? AND view='vtubers' AND scope_key='all'
              AND detail_key=?
            ORDER BY metric,rank
            """,
            (range_id, source_key),
        ).fetchall()
        expected_metrics = {"count", "songs", "videos"}
        actual_metrics = {_text(row[0]) for row in rows}
        if len(rows) != len(expected_metrics) or actual_metrics != expected_metrics:
            raise RuntimeError(
                "VTuber source song-count reconciliation has incomplete ranking rows: "
                f"{range_id}/{source_key} metrics={sorted(actual_metrics)}"
            )
        for metric, rank, raw_payload in rows:
            try:
                payload = json.loads(raw_payload)
            except (TypeError, json.JSONDecodeError) as exc:
                raise RuntimeError(
                    "VTuber source song-count reconciliation payload is invalid: "
                    f"{range_id}/{source_key}/{metric}/{rank}"
                ) from exc
            if not isinstance(payload, dict):
                raise RuntimeError(
                    "VTuber source song-count reconciliation payload is not an object: "
                    f"{range_id}/{source_key}/{metric}/{rank}"
                )
            if _integer(payload.get("songCount")) != ranking_song_count:
                raise RuntimeError(
                    "VTuber ranking songCount changed across metrics: "
                    f"{range_id}/{source_key}/{metric}/{rank}"
                )
            payload["songCount"] = source_song_count
            self.connection.execute(
                """
                UPDATE ranking_rows
                SET song_count=?,payload_json=?
                WHERE range_id=? AND view='vtubers' AND metric=?
                  AND scope_key='all' AND rank=? AND detail_key=?
                """,
                (
                    source_song_count,
                    _json_text(payload),
                    range_id,
                    metric,
                    int(rank),
                    source_key,
                ),
            )
        self._record_writes(len(rows))
        self.song_count_corrections[(range_id, source_key)] = source_song_count
        print(
            "PG_SNAPSHOT_VTUBER_SONG_COUNT_RECONCILE "
            f"range={range_id} source={source_key} "
            f"ranking={ranking_song_count} source={source_song_count}",
            flush=True,
        )

    def rewrite_static_vtuber_song_counts(self, range_id: str) -> None:
        """Persist VTuber scalar corrections into already-written page files."""

        root = self.static_ranking_root
        corrections = {
            source_key: int(song_count)
            for (corrected_range, source_key), song_count
            in self.song_count_corrections.items()
            if corrected_range == range_id
        }
        if root is None or not corrections:
            return
        for metric_name, db_metric in (
            ("occurrences", "count"),
            ("songs", "songs"),
            ("videos", "videos"),
        ):
            metric_root = root / range_id / "vtubers" / metric_name
            for path in sorted(metric_root.glob("page-*.json")):
                try:
                    payload = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as exc:
                    raise RuntimeError(
                        "VTuber static ranking page is invalid during song-count "
                        f"reconciliation: {path}"
                    ) from exc
                records = payload.get("records") if isinstance(payload, dict) else None
                if not isinstance(records, list):
                    raise RuntimeError(
                        "VTuber static ranking page records are invalid during "
                        f"song-count reconciliation: {path}"
                    )
                changed = False
                for record in records:
                    if not isinstance(record, dict):
                        continue
                    source_key = _text(record.get("sourceDetailKey"))
                    if source_key not in corrections:
                        continue
                    song_count = corrections[source_key]
                    if _integer(record.get("songCount")) != song_count:
                        record["songCount"] = song_count
                        changed = True
                if not changed:
                    continue
                totals = self.ranking_series_totals(
                    range_id=range_id,
                    view="vtubers",
                    metric=db_metric,
                    scope_key="all",
                )
                payload["totalSongCount"] = totals["totalSongCount"]
                _write_json_file_and_drop_cache(path, payload)

    def finish_source(self, state: Mapping[str, Any]) -> int:
        source_key = _text(state["source_key"])
        range_id = _text(state["range_id"])
        self.connection.execute(
            """
            UPDATE ranking_rows INDEXED BY ranking_rows_source_lookup
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
            raise RuntimeError(
                "source totals changed inside snapshot: "
                f"{range_id}/{source_key} page={page} "
                "expected="
                f"{expected_page_count}/{expected_video_count}/{expected_occurrence_count} "
                f"actual={page_count}/{video_count}/{occurrence_count}"
            )
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


def _parent_video_ranking_fallback(
    row: Mapping[str, Any],
    *,
    expected_video_id: str,
) -> tuple[dict[str, Any], tuple[dict[str, Any], ...]]:
    """Recover one legacy ranking-only video without weakening identity gates.

    Early full-runtime releases can retain a complete all-range video card while
    omitting that video's scalar ``runtime_videos`` and ``runtime_occurrences``
    rows.  The card's ``songs`` array is the only authoritative occurrence
    payload for that legacy shape.  Accept it only when every stored scalar and
    public identity agrees with the requested video.
    """

    video_id = _text(row.get("detail_key"))
    payload = _json_object(row.get("payload_json"))
    if video_id != expected_video_id or _text(payload.get("videoId")) != video_id:
        raise RuntimeError(
            "parent video ranking fallback changed identity: "
            f"expected={expected_video_id} actual={video_id or '<empty>'}"
        )
    detail_key = _text(payload.get("detailKey"))
    if detail_key and detail_key not in {video_id, f"all:{video_id}"}:
        raise RuntimeError(
            "parent video ranking fallback changed identity: "
            f"video={video_id} field=detailKey actual={detail_key}"
        )
    public_key = _text(payload.get("key"))
    if public_key and public_key != video_id:
        raise RuntimeError(
            "parent video ranking fallback changed identity: "
            f"video={video_id} field=key actual={public_key}"
        )
    if _text(payload.get("type")) not in {"", "video"}:
        raise RuntimeError(
            f"parent video ranking fallback changed type: {video_id}"
        )

    raw_songs = payload.get("songs")
    if not isinstance(raw_songs, list) or not raw_songs:
        raise RuntimeError(
            f"parent video ranking fallback has no songs: {video_id}"
        )
    occurrence_count = len(raw_songs)
    count_values = {
        "row_count": _integer(row.get("row_count"), -1),
        "timestamp_count": _integer(row.get("timestamp_count"), -1),
        "count": _integer(payload.get("count"), -1),
        "timestampCount": _integer(payload.get("timestampCount"), -1),
    }
    if any(value != occurrence_count for value in count_values.values()):
        raise RuntimeError(
            "parent video ranking fallback count changed: "
            f"video={video_id} songs={occurrence_count} values={count_values}"
        )
    if (
        _integer(row.get("video_count"), -1) != 1
        or _integer(payload.get("videoCount"), -1) != 1
    ):
        raise RuntimeError(
            f"parent video ranking fallback video count changed: {video_id}"
        )

    video_title = _text(payload.get("title") or row.get("title"))
    occurrences: list[dict[str, Any]] = []
    for position, raw_song in enumerate(raw_songs):
        if not isinstance(raw_song, Mapping):
            raise RuntimeError(
                "parent video ranking fallback song is invalid: "
                f"video={video_id} position={position}"
            )
        song = dict(raw_song)
        occurrence = dict(song)
        occurrence.update({
            "videoId": video_id,
            "videoTitle": video_title,
            "rangeId": "all",
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

    video_row = {
        "video_id": video_id,
        "title": video_title,
        "channel_name": payload.get("channelName"),
        "channel_id": payload.get("channelId"),
        "channel_handle": payload.get("channelHandle"),
        "channel_url": payload.get("channelUrl"),
        "published_timestamp": (
            payload.get("publishedTimestamp") or payload.get("publishedAt")
        ),
        "payload_json": payload,
    }
    return video_row, tuple(occurrences)


def _ordered_parent_video_sources(
    sources: Sequence[tuple[str, str]],
) -> tuple[tuple[str, str], ...]:
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
    return ordered


def _load_parent_video_source_batch(
    connection: Any,
    *,
    parent_revision_id: str,
    video_ids: Sequence[str],
) -> tuple[
    dict[str, dict[str, Any]],
    dict[str, tuple[dict[str, Any], ...]],
]:
    batch_video_ids = sorted({_text(value) for value in video_ids if _text(value)})
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
    if len(video_by_id) != len(video_rows):
        raise RuntimeError("parent video source lookup returned duplicate rows")
    extra = sorted(set(video_by_id) - set(batch_video_ids))
    if extra:
        raise RuntimeError(
            "parent video source lookup changed: "
            f"missing=[] extra={extra[:3]}"
        )

    ranking_fallback_occurrences: dict[
        str, tuple[dict[str, Any], ...]
    ] = {}
    missing_video_ids = sorted(set(batch_video_ids) - set(video_by_id))
    if missing_video_ids:
        fallback_rows = adapter._rows(
            connection,
            """
            SELECT detail_key,title,row_count,video_count,timestamp_count,
                   payload_json
            FROM runtime_ranking_rows
            WHERE revision_id = %s AND range_id = 'all'
              AND view = 'videos' AND metric = 'count'
              AND scope_key = 'all' AND detail_key = ANY(%s)
            ORDER BY detail_key
            LIMIT %s
            """,
            [
                parent_revision_id,
                missing_video_ids,
                len(missing_video_ids) + 1,
            ],
        )
        if len(fallback_rows) > len(missing_video_ids):
            raise RuntimeError(
                "parent video ranking fallback exceeded requested scope"
            )
        fallback_by_video: dict[str, dict[str, Any]] = {}
        for row in fallback_rows:
            video_id = _text(row.get("detail_key"))
            if video_id not in missing_video_ids or video_id in fallback_by_video:
                raise RuntimeError(
                    "parent video ranking fallback changed lookup identity"
                )
            fallback_by_video[video_id] = dict(row)
        unresolved = sorted(set(missing_video_ids) - set(fallback_by_video))
        if unresolved:
            raise RuntimeError(
                "parent video source lookup changed: "
                f"missing={unresolved[:3]} extra=[]"
            )
        for video_id in missing_video_ids:
            video_row, fallback_occurrences = _parent_video_ranking_fallback(
                fallback_by_video[video_id],
                expected_video_id=video_id,
            )
            video_by_id[video_id] = video_row
            ranking_fallback_occurrences[video_id] = fallback_occurrences
    if set(video_by_id) != set(batch_video_ids):
        missing = sorted(set(batch_video_ids) - set(video_by_id))
        extra = sorted(set(video_by_id) - set(batch_video_ids))
        raise RuntimeError(
            "parent video source lookup changed: "
            f"missing={missing[:3]} extra={extra[:3]}"
        )

    runtime_video_ids = sorted(
        set(batch_video_ids) - set(ranking_fallback_occurrences)
    )
    occurrence_rows = adapter._rows(
        connection,
        """
        SELECT DISTINCT video_id
        FROM runtime_occurrences
        WHERE revision_id = %s AND video_id = ANY(%s)
          AND range_id = ANY(%s)
        ORDER BY video_id
        LIMIT %s
        """,
        [
            parent_revision_id,
            runtime_video_ids,
            ["all", ""],
            len(runtime_video_ids) + 1,
        ],
    ) if runtime_video_ids else []
    occurrence_video_ids = {
        _text(row.get("video_id"))
        for row in occurrence_rows
        if _text(row.get("video_id"))
    }
    if len(occurrence_video_ids) != len(occurrence_rows):
        raise RuntimeError(
            "parent video occurrence preflight returned duplicate rows"
        )
    missing_occurrences = sorted(
        set(runtime_video_ids) - occurrence_video_ids
    )
    extra_occurrences = sorted(
        occurrence_video_ids - set(runtime_video_ids)
    )
    if missing_occurrences or extra_occurrences:
        raise RuntimeError(
            "parent video occurrence preflight changed: "
            f"missing={missing_occurrences[:3]} extra={extra_occurrences[:3]}"
        )
    return video_by_id, ranking_fallback_occurrences


def preflight_unaffected_parent_video_sources(
    connection: Any,
    *,
    parent_revision_id: str,
    sources: Sequence[tuple[str, str]],
) -> set[str]:
    """Validate direct parent-video fallbacks before the expensive source copy.

    Persisted parent details are handled by the bulk source stream.  Every
    remaining video source must already have an exact runtime video plus an
    all-range occurrence, or a complete legacy ranking-only card.  Performing
    this bounded lookup first turns a multi-hour late failure into a gate just
    after the ranking/source-scope phase.
    """

    ordered = _ordered_parent_video_sources(sources)
    direct_source_keys: set[str] = set()
    for offset in range(0, len(ordered), PARENT_VIDEO_EXPORT_BATCH):
        batch = ordered[offset : offset + PARENT_VIDEO_EXPORT_BATCH]
        batch_source_keys = [source_key for source_key, _ in batch]
        detail_rows = adapter._rows(
            connection,
            """
            SELECT detail.source_key
            FROM runtime_source_details AS detail
            WHERE detail.revision_id = %s AND detail.range_id = 'all'
              AND detail.source_key = ANY(%s)
              AND EXISTS (
                SELECT 1 FROM runtime_source_occurrences AS occurrence
                WHERE occurrence.revision_id = detail.revision_id
                  AND occurrence.source_key = detail.source_key
                  AND occurrence.range_id = detail.range_id
              )
            ORDER BY detail.source_key
            LIMIT %s
            """,
            [
                parent_revision_id,
                batch_source_keys,
                len(batch_source_keys) + 1,
            ],
        )
        persisted_keys = {
            _text(row.get("source_key"))
            for row in detail_rows
            if _text(row.get("source_key"))
        }
        if len(persisted_keys) != len(detail_rows):
            raise RuntimeError(
                "parent video preflight detail lookup changed identity"
            )
        escaped = sorted(persisted_keys - set(batch_source_keys))
        if escaped:
            raise RuntimeError(
                "parent video preflight detail escaped scope: "
                + ", ".join(escaped[:3])
            )
        direct_batch = tuple(
            (source_key, video_id)
            for source_key, video_id in batch
            if source_key not in persisted_keys
        )
        if direct_batch:
            _load_parent_video_source_batch(
                connection,
                parent_revision_id=parent_revision_id,
                video_ids=[video_id for _, video_id in direct_batch],
            )
            direct_source_keys.update(
                source_key for source_key, _ in direct_batch
            )
    print(
        "PG_SNAPSHOT_PARENT_VIDEO_PREFLIGHT "
        f"total={len(ordered)} direct={len(direct_source_keys)}",
        flush=True,
    )
    return direct_source_keys


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

    ordered = _ordered_parent_video_sources(sources)

    completed: set[str] = set()
    for offset in range(0, len(ordered), PARENT_VIDEO_EXPORT_BATCH):
        batch = ordered[offset : offset + PARENT_VIDEO_EXPORT_BATCH]
        batch_by_video = {
            video_id: source_key for source_key, video_id in batch
        }
        batch_video_ids = sorted(batch_by_video)
        video_by_id, ranking_fallback_occurrences = (
            _load_parent_video_source_batch(
                connection,
                parent_revision_id=parent_revision_id,
                video_ids=batch_video_ids,
            )
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
        for video_id in sorted(ranking_fallback_occurrences):
            source_key = batch_by_video[video_id]
            if source_key in completed:
                continue
            current_video_id = video_id
            current_occurrences = list(ranking_fallback_occurrences[video_id])
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


def export_unaffected_parent_sources(
    connection: Any,
    writer: CanonicalSnapshotWriter,
    *,
    parent_revision_id: str,
    source_keys: Iterable[str],
    affected_source_keys: Iterable[str],
) -> set[str]:
    """Stream immutable persisted parent sources without per-source round trips.

    Only source keys with no overlay-affected member video are eligible.  The
    parent detail and its physical occurrence projection are copied verbatim
    through the canonical SQLite writer; overlay-only keys and historical video
    sources without a persisted detail remain pending for the existing
    delta-aware paths.
    """

    requested = {
        _text(value) for value in source_keys if _text(value)
    }
    affected = {
        _text(value) for value in affected_source_keys if _text(value)
    }
    ordered = tuple(sorted(requested - affected))
    completed: set[str] = set()
    for offset in range(0, len(ordered), PARENT_SOURCE_EXPORT_BATCH):
        batch = ordered[offset : offset + PARENT_SOURCE_EXPORT_BATCH]
        detail_rows = adapter._rows(
            connection,
            """
            SELECT source_key,entity_type,entity_key,payload_json
            FROM runtime_source_details
            WHERE revision_id = %s AND range_id = 'all'
              AND source_key = ANY(%s)
            ORDER BY source_key
            LIMIT %s
            """,
            [parent_revision_id, list(batch), len(batch) + 1],
        )
        if len(detail_rows) > len(batch):
            raise RuntimeError("parent source detail lookup exceeded requested batch")
        details: dict[str, dict[str, Any]] = {}
        declared_counts: dict[str, int | None] = {}
        declared_video_counts: dict[str, int | None] = {}
        for row in detail_rows:
            source_key = _text(row.get("source_key"))
            if source_key not in batch or source_key in details:
                raise RuntimeError("parent source detail lookup changed identity")
            record = _json_object(row.get("payload_json"))
            explicit_source_key = _text(record.get("sourceDetailKey"))
            if explicit_source_key and explicit_source_key != source_key:
                raise RuntimeError("parent source detail key disagrees with authority")
            explicit_range = _text(record.get("rangeId"))
            if explicit_range and explicit_range != "all":
                raise RuntimeError("parent source detail range disagrees with authority")
            entity_type = _text(row.get("entity_type")) or "source"
            entity_key = _text(row.get("entity_key")) or source_key
            if _text(record.get("type")) and _text(record.get("type")) != entity_type:
                raise RuntimeError("parent source detail type disagrees with authority")
            if _text(record.get("key")) and _text(record.get("key")) != entity_key:
                raise RuntimeError("parent source detail entity key disagrees with authority")
            record.setdefault("type", entity_type)
            record.setdefault("key", entity_key)
            record["sourceDetailKey"] = source_key
            record["rangeId"] = "all"
            details[source_key] = record

            declared_value = next(
                (
                    record.get(name)
                    for name in ("occurrenceCount", "count", "timestampCount")
                    if record.get(name) is not None
                ),
                None,
            )
            declared_count = int(declared_value) if declared_value is not None else None
            if declared_count is not None and declared_count < 0:
                raise RuntimeError("parent source occurrence count is invalid")
            declared_counts[source_key] = declared_count
            declared_video_value = record.get("videoCount")
            declared_video_count = (
                int(declared_video_value)
                if declared_video_value is not None
                else None
            )
            if declared_video_count is not None and declared_video_count < 0:
                raise RuntimeError("parent source video count is invalid")
            declared_video_counts[source_key] = declared_video_count

        current_key = ""
        state: dict[str, Any] | None = None
        occurrence_buffer: list[dict[str, Any]] = []
        physical_rows = 0
        physical_videos: set[str] = set()
        streamed_rows = 0

        def flush_occurrences() -> None:
            nonlocal occurrence_buffer
            if state is not None and occurrence_buffer:
                writer.add_source_occurrences(state, occurrence_buffer)
                occurrence_buffer = []

        def finish_current() -> None:
            nonlocal current_key, state, physical_rows, physical_videos
            if not current_key or state is None:
                return
            flush_occurrences()
            written = writer.finish_source(state)
            if written != physical_rows:
                raise RuntimeError("parent source occurrence stream lost rows")
            declared_count = declared_counts[current_key]
            if declared_count is not None and declared_count != written:
                raise RuntimeError(
                    "parent source occurrence total disagrees with detail: "
                    + current_key
                )
            declared_video_count = declared_video_counts[current_key]
            if (
                declared_video_count is not None
                and declared_video_count != len(physical_videos)
            ):
                raise RuntimeError(
                    "parent source video total disagrees with detail: "
                    + current_key
                )
            completed.add(current_key)
            current_key = ""
            state = None
            physical_rows = 0
            physical_videos = set()

        for row in _stream_pg_rows(
            connection,
            f"parent_sources_{offset // PARENT_SOURCE_EXPORT_BATCH}",
            """
            SELECT source_key,position,video_id,title,channel_name,channel_id,
                   channel_handle,channel_url,published_timestamp,seconds,
                   is_niche,is_unknown_artist,payload_json
            FROM runtime_source_occurrences
            WHERE revision_id = %s AND range_id = 'all'
              AND source_key = ANY(%s)
            ORDER BY source_key,position
            LIMIT %s
            """,
            [
                parent_revision_id,
                sorted(details),
                MAX_SOURCE_SCOPE_ROWS + 1,
            ],
            fetch_size=SOURCE_SCOPE_PAYLOAD_FETCH_SIZE,
        ) if details else ():
            streamed_rows += 1
            if streamed_rows > MAX_SOURCE_SCOPE_ROWS:
                raise RuntimeError("parent source occurrence batch exceeded bounded cap")
            source_key = _text(row.get("source_key"))
            if source_key not in details:
                raise RuntimeError("parent source occurrence escaped requested detail set")
            if current_key and source_key != current_key:
                finish_current()
            if not current_key:
                current_key = source_key
                state = writer.begin_source(source_key, "all", details[source_key])
            physical_rows += 1
            video_id = _text(row.get("video_id"))
            if video_id:
                physical_videos.add(video_id)
            occurrence_buffer.append(adapter._runtime_source_occurrence(row))
            if len(occurrence_buffer) >= SOURCE_WRITE_BATCH_SIZE:
                flush_occurrences()
        finish_current()

        if not completed.issubset(requested):
            raise RuntimeError("parent source bulk export introduced an unknown key")
        if len(completed) % 1_000 < len(batch):
            print(
                "PG_SNAPSHOT_PARENT_SOURCES "
                f"complete={len(completed)} eligible={len(ordered)}",
                flush=True,
            )
        detail_rows = None
        details = {}
        gc.collect()
    if len(completed) % 1_000:
        print(
            "PG_SNAPSHOT_PARENT_SOURCES "
            f"complete={len(completed)} eligible={len(ordered)}",
            flush=True,
        )
    return completed


def export_affected_parent_sources(
    connection: Any,
    writer: CanonicalSnapshotWriter,
    *,
    parent_revision_id: str,
    overlay_revision_ids: Sequence[str],
    source_scope: SnapshotSourceScope,
    source_keys: Iterable[str],
) -> set[str]:
    """Materialize affected generic-all sources with bounded batch SQL.

    A 500-key metadata window reads parent details once and is then split by
    each detail's declared occurrence count.  Within each adaptive batch the
    union overlay delta is shared, while physical parent rows are retained for
    only the current ``source_key`` and are written and released at the next
    key boundary.  No key in this path may fall back to the paged endpoint
    loader.
    """

    requested = {
        _text(value) for value in source_keys if _text(value)
    }
    source_lineage = tuple(dict.fromkeys((
        *(_text(value) for value in overlay_revision_ids if _text(value)),
        _text(parent_revision_id),
    )))
    if not source_lineage or not _text(parent_revision_id):
        raise RuntimeError("affected parent source lineage is empty")
    completed: set[str] = set()
    for metadata_index, (batch, scoped, _union_videos) in enumerate(
        source_scope.source_batches(requested)
    ):
        detail_rows = adapter._rows(
            connection,
            """
            SELECT DISTINCT ON (source_key)
                   revision_id,source_key,entity_type,entity_key,payload_json
            FROM runtime_source_details
            WHERE revision_id::text = ANY(%s::text[]) AND range_id = 'all'
              AND source_key = ANY(%s)
            ORDER BY source_key,
                     array_position(%s::text[],revision_id::text)
            LIMIT %s
            """,
            [
                list(source_lineage),
                list(batch),
                list(source_lineage),
                len(batch) + 1,
            ],
        )
        if len(detail_rows) > len(batch):
            raise RuntimeError(
                "affected parent source detail lookup exceeded requested batch"
            )
        details: dict[str, dict[str, Any]] = {}
        detail_revisions: dict[str, str] = {}
        declared_counts: dict[str, int] = {}
        for row in detail_rows:
            source_key = _text(row.get("source_key"))
            if source_key not in batch or source_key in details:
                raise RuntimeError(
                    "affected parent source detail lookup changed identity"
                )
            detail_revision_id = _text(row.get("revision_id"))
            if detail_revision_id not in source_lineage:
                raise RuntimeError(
                    "affected parent source detail escaped active lineage"
                )
            record = _json_object(row.get("payload_json"))
            entity_type = _text(row.get("entity_type")) or _text(
                record.get("type")
            ) or "source"
            entity_key = _text(row.get("entity_key")) or _text(
                record.get("key")
            ) or source_key
            if _text(record.get("sourceDetailKey")) not in {"", source_key}:
                raise RuntimeError(
                    "affected parent source detail key disagrees with authority"
                )
            if _text(record.get("rangeId")) not in {"", "all"}:
                raise RuntimeError(
                    "affected parent source detail range disagrees with authority"
                )
            if _text(record.get("type")) not in {"", entity_type}:
                raise RuntimeError(
                    "affected parent source detail type disagrees with authority"
                )
            if _text(record.get("key")) not in {"", entity_key}:
                raise RuntimeError(
                    "affected parent source entity key disagrees with authority"
                )
            record.setdefault("type", entity_type)
            record.setdefault("key", entity_key)
            record["sourceDetailKey"] = source_key
            record["rangeId"] = "all"
            details[source_key] = record
            detail_revisions[source_key] = detail_revision_id
            declared_values: list[int] = []
            for name in ("occurrenceCount", "count", "timestampCount"):
                value = record.get(name)
                if value is None:
                    continue
                try:
                    declared_value = int(value)
                except (TypeError, ValueError) as exc:
                    raise RuntimeError(
                        "affected parent source occurrence count is invalid: "
                        + source_key
                    ) from exc
                if declared_value < 0:
                    raise RuntimeError(
                        "affected parent source occurrence count is invalid: "
                        + source_key
                    )
                declared_values.append(declared_value)
            if not declared_values:
                raise RuntimeError(
                    "affected parent source occurrence count is missing: "
                    + source_key
                )
            if len(set(declared_values)) != 1:
                raise RuntimeError(
                    "affected parent source occurrence counts disagree: "
                    + source_key
                )
            declared_count = declared_values[0]
            if declared_count > PARENT_SOURCE_OCCURRENCE_BATCH_ROWS:
                raise RuntimeError(
                    "affected parent source occurrence count exceeded "
                    "single-source batch cap: "
                    + source_key
                )
            declared_counts[source_key] = declared_count

        direct_sources: dict[str, str] = {}
        for source_key in batch:
            if source_key in details:
                continue
            video_targets = {
                group_key
                for view, group_key in scoped[source_key]["targets"]
                if view == "videos" and group_key
            }
            if video_targets:
                if len(video_targets) != 1:
                    raise RuntimeError(
                        "affected direct video source has ambiguous target"
                    )
                direct_sources[source_key] = next(iter(video_targets))
        direct_video_ids = sorted(set(direct_sources.values()))
        if len(direct_video_ids) != len(direct_sources):
            raise RuntimeError(
                "affected direct video source has ambiguous parent identity"
            )
        direct_count_rows = adapter._rows(
            connection,
            """
            SELECT video_id,count(*) AS occurrence_count
            FROM runtime_occurrences
            WHERE revision_id = %s AND video_id = ANY(%s)
              AND range_id = ANY(%s)
            GROUP BY video_id
            ORDER BY video_id
            LIMIT %s
            """,
            [
                parent_revision_id,
                direct_video_ids,
                ["all", ""],
                len(direct_video_ids) + 1,
            ],
        ) if direct_video_ids else []
        if len(direct_count_rows) > len(direct_video_ids):
            raise RuntimeError(
                "affected direct video occurrence count exceeded requested batch"
            )
        direct_counts = {video_id: 0 for video_id in direct_video_ids}
        for row in direct_count_rows:
            video_id = _text(row.get("video_id"))
            if video_id not in direct_counts:
                raise RuntimeError(
                    "affected direct video occurrence count escaped scope"
                )
            try:
                occurrence_count = int(row.get("occurrence_count"))
            except (TypeError, ValueError) as exc:
                raise RuntimeError(
                    "affected direct video occurrence count is invalid"
                ) from exc
            if (
                occurrence_count < 0
                or occurrence_count > PARENT_SOURCE_OCCURRENCE_BATCH_ROWS
            ):
                raise RuntimeError(
                    "affected direct video occurrence count exceeded "
                    "single-source batch cap"
                )
            direct_counts[video_id] = occurrence_count

        source_plans: dict[str, tuple[str, tuple[str, ...]]] = {}
        for source_key in batch:
            if source_key in detail_revisions:
                source_base_revision, source_overlay_ids = (
                    adapter._source_detail_delta_lineage(
                        overlay_revision_ids,
                        detail_revisions[source_key],
                        parent_revision_id,
                    )
                )
            else:
                source_base_revision = parent_revision_id
                source_overlay_ids = [
                    _text(value)
                    for value in overlay_revision_ids
                    if _text(value)
                ]
            source_plans[source_key] = (
                _text(source_base_revision),
                tuple(_text(value) for value in source_overlay_ids if _text(value)),
            )

        adaptive_batches: list[tuple[str, ...]] = []
        adaptive_batch: list[str] = []
        adaptive_rows = 0
        for source_key in batch:
            occurrence_count = (
                declared_counts[source_key]
                if source_key in details
                else direct_counts.get(direct_sources.get(source_key, ""), 0)
            )
            if (
                adaptive_batch
                and adaptive_rows + occurrence_count
                    > PARENT_SOURCE_OCCURRENCE_BATCH_ROWS
            ):
                adaptive_batches.append(tuple(adaptive_batch))
                adaptive_batch = []
                adaptive_rows = 0
            adaptive_batch.append(source_key)
            adaptive_rows += occurrence_count
        if adaptive_batch:
            adaptive_batches.append(tuple(adaptive_batch))

        for stream_index, stream_batch in enumerate(adaptive_batches):
            stream_scoped = {
                source_key: scoped[source_key] for source_key in stream_batch
            }
            stream_union_videos = tuple(sorted({
                video_id
                for values in stream_scoped.values()
                for video_id in values["videos"]
            }))
            stream_direct_sources = {
                source_key: direct_sources[source_key]
                for source_key in stream_batch
                if source_key in direct_sources
            }
            stream_direct_video_ids = sorted(set(stream_direct_sources.values()))
            direct_video_rows = adapter._rows(
                connection,
                """
                SELECT video_id,title,channel_name,channel_id,channel_handle,
                       channel_url,published_timestamp,payload_json
                FROM runtime_videos
                WHERE revision_id = %s AND video_id = ANY(%s)
                ORDER BY video_id
                LIMIT %s
                """,
                [
                    parent_revision_id,
                    stream_direct_video_ids,
                    len(stream_direct_video_ids) + 1,
                ],
            ) if stream_direct_video_ids else []
            if len(direct_video_rows) > len(stream_direct_video_ids):
                raise RuntimeError(
                    "affected direct video detail exceeded requested batch"
                )
            direct_video_by_id: dict[str, dict[str, Any]] = {}
            for row in direct_video_rows:
                video_id = _text(row.get("video_id"))
                if (
                    video_id not in stream_direct_video_ids
                    or video_id in direct_video_by_id
                ):
                    raise RuntimeError(
                        "affected direct video detail changed identity"
                    )
                direct_video_by_id[video_id] = row
            for video_id in stream_direct_video_ids:
                if direct_counts[video_id] and video_id not in direct_video_by_id:
                    raise RuntimeError(
                        "affected direct video occurrence has no parent detail"
                    )

            plan_members: dict[
                tuple[str, tuple[str, ...]], list[str]
            ] = {}
            for source_key in stream_batch:
                plan_members.setdefault(source_plans[source_key], []).append(
                    source_key
                )
            overlay_inputs_by_plan: dict[
                tuple[str, tuple[str, ...]],
                tuple[
                    tuple[Mapping[str, Any], ...],
                    dict[str, dict[str, Any]],
                    tuple[Mapping[str, Any], ...],
                ],
            ] = {}
            for plan, plan_source_keys in plan_members.items():
                source_base_revision, source_overlay_ids = plan
                plan_union_videos = tuple(sorted({
                    video_id
                    for source_key in plan_source_keys
                    for video_id in stream_scoped[source_key]["videos"]
                }))
                overlay_inputs_by_plan[plan] = (
                    adapter._snapshot_source_overlay_inputs(
                        connection,
                        source_base_revision,
                        source_overlay_ids,
                        "all",
                        plan_union_videos,
                        include_compatible_full_reset_7d=True,
                    )
                    if source_overlay_ids
                    else ((), {}, ())
                )

            def write_source(
                source_key: str,
                *,
                parent_rows: list[dict[str, Any]] | None = None,
                direct_rows: list[dict[str, Any]] | None = None,
            ) -> None:
                parent_rows = parent_rows if parent_rows is not None else []
                direct_rows = direct_rows if direct_rows is not None else []
                direct_video_id = stream_direct_sources.get(source_key, "")
                try:
                    candidate_rows, accepted_resets, runtime_changes = (
                        overlay_inputs_by_plan[source_plans[source_key]]
                    )
                    payload = adapter._snapshot_materialized_source_payload(
                        source_key,
                        range_id="all",
                        persisted_record=details.get(source_key),
                        targets=stream_scoped[source_key]["targets"],
                        video_scope=stream_scoped[source_key]["videos"],
                        parent_occurrences=parent_rows,
                        direct_video_rows=(
                            (direct_video_by_id[direct_video_id],)
                            if direct_video_id in direct_video_by_id else ()
                        ),
                        direct_occurrence_rows=direct_rows,
                        candidate_rows=candidate_rows,
                        accepted_video_resets=accepted_resets,
                        runtime_changes=runtime_changes,
                    )
                    if payload.get("found") is not True:
                        raise RuntimeError(
                            "affected canonical source is missing: "
                            f"all/{source_key}"
                        )
                    record = payload.get("record")
                    if not isinstance(record, Mapping):
                        raise RuntimeError(
                            "affected canonical source is invalid: "
                            f"all/{source_key}"
                        )
                    occurrences = record.get("occurrences")
                    if not isinstance(occurrences, list) or not occurrences:
                        raise RuntimeError(
                            "affected canonical source is empty: "
                            f"all/{source_key}"
                        )
                    detail = dict(record)
                    detail.pop("occurrences", None)
                    writer.add_source(source_key, "all", detail, occurrences)
                    completed.add(source_key)
                finally:
                    # The overlay is shared metadata for this stream batch, but
                    # parent payload graphs are strictly one-source-at-a-time.
                    parent_rows.clear()
                    direct_rows.clear()

            persisted_keys = tuple(sorted(
                source_key
                for source_key in stream_batch
                if source_key in details
            ))
            expected_parent_rows = sum(
                declared_counts[source_key] for source_key in persisted_keys
            )
            current_source_key = ""
            current_parent_rows: list[dict[str, Any]] = []
            written_persisted: set[str] = set()
            streamed_parent_rows = 0

            def finish_parent_source() -> None:
                nonlocal current_source_key, current_parent_rows
                if not current_source_key:
                    return
                if len(current_parent_rows) != declared_counts[current_source_key]:
                    raise RuntimeError(
                        "affected parent source occurrence total disagrees "
                        "with detail: " + current_source_key
                    )
                write_source(
                    current_source_key,
                    parent_rows=current_parent_rows,
                )
                written_persisted.add(current_source_key)
                current_source_key = ""
                current_parent_rows = []

            for row in _stream_pg_rows(
                connection,
                f"affected_parent_sources_{metadata_index}_{stream_index}",
                """
                WITH requested(source_key,revision_id) AS (
                  SELECT * FROM unnest(%s::text[],%s::text[])
                )
                SELECT occurrence.revision_id,occurrence.source_key,
                       occurrence.position,occurrence.video_id,occurrence.title,
                       occurrence.channel_name,occurrence.channel_id,
                       occurrence.channel_handle,occurrence.channel_url,
                       occurrence.published_timestamp,occurrence.seconds,
                       occurrence.is_niche,occurrence.is_unknown_artist,
                       occurrence.payload_json
                FROM runtime_source_occurrences AS occurrence
                JOIN requested
                  ON requested.source_key=occurrence.source_key
                 AND requested.revision_id=occurrence.revision_id::text
                WHERE occurrence.range_id = 'all'
                ORDER BY occurrence.source_key,occurrence.position
                LIMIT %s
                """,
                [
                    list(persisted_keys),
                    [detail_revisions[source_key] for source_key in persisted_keys],
                    expected_parent_rows + 1,
                ],
                fetch_size=SOURCE_SCOPE_PAYLOAD_FETCH_SIZE,
            ) if expected_parent_rows else ():
                streamed_parent_rows += 1
                if streamed_parent_rows > expected_parent_rows:
                    raise RuntimeError(
                        "affected parent source occurrence stream exceeded "
                        "declared total"
                    )
                source_key = _text(row.get("source_key"))
                if source_key not in persisted_keys:
                    raise RuntimeError(
                        "affected parent occurrence escaped requested detail set"
                    )
                if _text(row.get("revision_id")) != detail_revisions[source_key]:
                    raise RuntimeError(
                        "affected parent occurrence escaped source base revision"
                    )
                if source_key != current_source_key:
                    finish_parent_source()
                    if source_key in written_persisted:
                        raise RuntimeError(
                            "affected parent occurrence stream is not ordered"
                        )
                    current_source_key = source_key
                current_parent_rows.append(
                    adapter._runtime_source_occurrence(row)
                )
            finish_parent_source()
            for source_key in persisted_keys:
                if source_key in written_persisted:
                    continue
                if declared_counts[source_key] != 0:
                    raise RuntimeError(
                        "affected parent source occurrence stream is incomplete: "
                        + source_key
                    )
                write_source(source_key)
                written_persisted.add(source_key)

            direct_source_by_video = {
                video_id: source_key
                for source_key, video_id in stream_direct_sources.items()
            }
            expected_direct_rows = sum(
                direct_counts[video_id]
                for video_id in direct_source_by_video
            )
            current_direct_key = ""
            current_direct_rows: list[dict[str, Any]] = []
            written_direct: set[str] = set()
            streamed_direct_rows = 0

            def finish_direct_source() -> None:
                nonlocal current_direct_key, current_direct_rows
                if not current_direct_key:
                    return
                video_id = stream_direct_sources[current_direct_key]
                if len(current_direct_rows) != direct_counts[video_id]:
                    raise RuntimeError(
                        "affected direct video occurrence total disagrees "
                        "with parent: " + current_direct_key
                    )
                write_source(current_direct_key, direct_rows=current_direct_rows)
                written_direct.add(current_direct_key)
                current_direct_key = ""
                current_direct_rows = []

            for row in _stream_pg_rows(
                connection,
                f"affected_direct_sources_{metadata_index}_{stream_index}",
                """
                SELECT occurrence_id,range_id,video_id,song_key,seconds,
                       source_system,source_id,title,artist,is_niche,
                       is_unknown_artist,payload_json
                FROM runtime_occurrences
                WHERE revision_id = %s AND video_id = ANY(%s)
                  AND range_id = ANY(%s)
                ORDER BY video_id,range_id,occurrence_id
                LIMIT %s
                """,
                [
                    parent_revision_id,
                    sorted(direct_source_by_video),
                    ["all", ""],
                    expected_direct_rows + 1,
                ],
                fetch_size=SOURCE_SCOPE_PAYLOAD_FETCH_SIZE,
            ) if expected_direct_rows else ():
                streamed_direct_rows += 1
                if streamed_direct_rows > expected_direct_rows:
                    raise RuntimeError(
                        "affected direct video occurrence stream exceeded "
                        "declared total"
                    )
                video_id = _text(row.get("video_id"))
                source_key = direct_source_by_video.get(video_id, "")
                if not source_key:
                    raise RuntimeError(
                        "affected direct video occurrence escaped scope"
                    )
                if source_key != current_direct_key:
                    finish_direct_source()
                    if source_key in written_direct:
                        raise RuntimeError(
                            "affected direct video occurrence stream is not ordered"
                        )
                    current_direct_key = source_key
                current_direct_rows.append(row)
            finish_direct_source()
            for source_key in stream_direct_sources:
                if source_key in written_direct:
                    continue
                video_id = stream_direct_sources[source_key]
                if direct_counts[video_id] != 0:
                    raise RuntimeError(
                        "affected direct video occurrence stream is incomplete: "
                        + source_key
                    )
                write_source(source_key)
                written_direct.add(source_key)

            for source_key in stream_batch:
                if source_key not in details and source_key not in direct_sources:
                    write_source(source_key)

            print(
                "PG_SNAPSHOT_AFFECTED_PARENT_SOURCES "
                f"complete={len(completed)} total={len(requested)}",
                flush=True,
            )
            direct_video_rows = None
            direct_video_by_id = {}
            overlay_inputs_by_plan = {}
            gc.collect()
        detail_rows = None
        details = {}
        detail_revisions = {}
        declared_counts = {}
        direct_count_rows = None
        direct_counts = {}
        source_plans = {}
        gc.collect()
    if completed != requested:
        missing = sorted(requested - completed)
        raise RuntimeError(
            "affected parent source bulk export is incomplete: "
            + ", ".join(missing[:10])
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
        # Artist cards and source details must share the same immutable parent
        # alias owner and physical source totals.  Reuse only these bounded
        # scalar identities inside this repeatable-read snapshot.
        self.snapshot_artist_aliases: dict[
            tuple[str, str, str], tuple[str, str, str]
        ] = {}
        self.snapshot_artist_source_totals: dict[
            tuple[str, str, str, str], tuple[int, int]
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
        # A serving snapshot stores compact list cards and exports the full
        # canonical song multiset through source details.  Tell the adapter it
        # may retain only bounded private song-search text while preparing
        # VTuber cards, instead of holding duplicate per-channel song arrays
        # until every page has been written.  Online PG requests do not set
        # these internal flags and keep their established full response shape.
        options["_snapshotCompactCards"] = True
        options["_snapshotSongSearchMaxChars"] = MAX_RANKING_SEARCH_CHARS
        options["_snapshotBulkHydrateCards"] = True
        prepared = adapter._prepare_generic_overlay_rankings(
            self.connection,
            revision_id,
            self.parent,
            options,
            reconciliation_counts=self.reconciliation_counts,
            snapshot_reset_changes=self.snapshot_reset_changes,
            snapshot_original_group_counts=self.snapshot_original_group_counts,
            snapshot_vtuber_source_totals=self.snapshot_vtuber_source_totals,
            snapshot_artist_aliases=getattr(
                self, "snapshot_artist_aliases", None,
            ),
            snapshot_artist_source_totals=getattr(
                self, "snapshot_artist_source_totals", None,
            ),
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
        writer.static_ranking_root = output_root / "rankings"
        written = 0
        static_page_cache_drop_attempts = 0
        static_page_cache_drop_count = 0

        def write_static_page(target: Path, payload: Mapping[str, Any]) -> None:
            nonlocal written
            nonlocal static_page_cache_drop_attempts
            nonlocal static_page_cache_drop_count
            static_page_cache_drop_attempts += 1
            static_page_cache_drop_count += int(
                _write_json_file_and_drop_cache(target, payload)
            )
            written += 1
            if written % 25 == 0:
                print(
                    f"PG_SNAPSHOT_WRITTEN files={written} "
                    f"page_cache_drops={static_page_cache_drop_count}/"
                    f"{static_page_cache_drop_attempts}",
                    flush=True,
                )

        scope_counts: dict[str, int] = {}
        source_keys: dict[str, set[str]] = {range_id: set() for range_id in RANGES}
        for range_id in RANGES:
            for view in VIEWS:
                for scope_key, _niche, _hidden in SCOPES[:1]:
                    # Hydrate each canonical entity set from PostgreSQL once.
                    # minCount is fixed at one, so songs/videos contain the
                    # same positive entities and differ only in deterministic
                    # ordering.  The two alternate series are derived below
                    # from the canonical SQLite rows instead of repeating the
                    # expensive overlay reconciliation and payload hydration.
                    metric = "occurrences"
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
                    series_key = f"{range_id}/{view}/count/{scope_key}"
                    scope_counts[series_key] = total
                    target_dir = output_root / "rankings" / range_id / view / metric
                    if scope_key == "all":
                        target_dir.mkdir(parents=True, exist_ok=True)
                    rendered_record_count = 0
                    derived_payload_template: dict[str, Any] | None = None
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
                        rendered_record_count += len(records)
                        for index, raw in enumerate(records, start=1):
                            if not isinstance(raw, Mapping):
                                raise RuntimeError(
                                    f"ranking record is not an object: "
                                    f"{series_key}/{page}/{index}"
                                )
                        records = [
                            _complete_ranking_metric_scalars(raw, view)
                            for raw in records
                        ]
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
                                source_keys[range_id].add(detail_key)
                        if page == 1:
                            derived_payload_template = {
                                key: value
                                for key, value in payload.items()
                                if key != "records"
                            }
                            derived_payload_template["compact"] = True
                        del compact_records
                    validate_complete_ranking_series(
                        series_key, total, rendered_record_count,
                    )
                    if derived_payload_template is None:
                        raise RuntimeError(
                            f"ranking payload template is missing: {series_key}"
                        )
                    canonical_totals = writer.ranking_series_totals(
                        range_id=range_id,
                        view=view,
                        metric="count",
                        scope_key=scope_key,
                    )
                    if canonical_totals["totalCount"] != total:
                        raise RuntimeError(
                            f"canonical ranking total is invalid: {series_key}"
                        )
                    derived_payload_template.update(canonical_totals)
                    print(
                        f"PG_SNAPSHOT_COMBO {range_id}/{view}/{metric}/{scope_key} "
                        f"total={total} pages={page_count}",
                        flush=True,
                    )
                    # The render closure owns the page-independent aggregate,
                    # which can contain tens of thousands of Python objects.
                    # Release it before the two bounded SQLite re-ranks.
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
                        builder=builder,
                    )

                    if scope_key == "all":
                        target_dir = (
                            output_root / "rankings" / range_id / view / metric
                        )
                        target_dir.mkdir(parents=True, exist_ok=True)
                        stored_page_count = 0
                        stored_record_count = 0
                        for page, stored_records in writer.ranking_metric_pages(
                            range_id=range_id,
                            view=view,
                            metric="count",
                            scope_key=scope_key,
                            page_size=PAGE_SIZE,
                        ):
                            stored_page_count += 1
                            records = [dict(record) for record in stored_records]
                            payload = dict(derived_payload_template)
                            payload["metric"] = metric
                            payload["page"] = page
                            payload["records"] = records
                            payload["compact"] = True
                            validate_page(
                                payload,
                                range_id=range_id,
                                view=view,
                                metric=metric,
                                page=page,
                                expected_total=total,
                            )
                            stored_record_count += len(records)
                            write_static_page(
                                target_dir / f"page-{page:04d}.json",
                                payload,
                            )
                        if stored_page_count != page_count:
                            raise RuntimeError(
                                f"stored ranking page count is invalid: "
                                f"{series_key} expected={page_count} "
                                f"actual={stored_page_count}"
                            )
                        validate_complete_ranking_series(
                            series_key, total, stored_record_count,
                        )
                        payload = None
                        records = None
                        stored_records = None

                    for metric in METRICS[1:]:
                        db_metric = metric
                        series_key = (
                            f"{range_id}/{view}/{db_metric}/{scope_key}"
                        )
                        scope_counts[series_key] = total
                        target_dir = (
                            output_root / "rankings" / range_id / view / metric
                        )
                        if scope_key == "all":
                            target_dir.mkdir(parents=True, exist_ok=True)
                        rendered_record_count = 0
                        rendered_page_count = 0
                        for page, derived_records in (
                            writer.derive_ranking_metric_pages(
                                range_id=range_id,
                                view=view,
                                scope_key=scope_key,
                                source_metric="count",
                                target_metric=db_metric,
                                page_size=PAGE_SIZE,
                            )
                        ):
                            rendered_page_count += 1
                            if page != rendered_page_count:
                                raise RuntimeError(
                                    f"derived ranking page order is invalid: "
                                    f"{series_key}/{page}"
                                )
                            records = [dict(record) for record in derived_records]
                            payload = dict(derived_payload_template)
                            payload["metric"] = metric
                            payload["page"] = page
                            payload["records"] = records
                            payload["compact"] = True
                            validate_page(
                                payload,
                                range_id=range_id,
                                view=view,
                                metric=metric,
                                page=page,
                                expected_total=total,
                            )
                            rendered_record_count += len(records)
                            if scope_key == "all":
                                target = target_dir / f"page-{page:04d}.json"
                                write_static_page(target, payload)
                        if rendered_page_count != page_count:
                            raise RuntimeError(
                                f"derived ranking page count is invalid: "
                                f"{series_key} expected={page_count} "
                                f"actual={rendered_page_count}"
                            )
                        validate_complete_ranking_series(
                            series_key, total, rendered_record_count,
                        )
                        print(
                            f"PG_SNAPSHOT_COMBO {range_id}/{view}/{metric}/{scope_key} "
                            f"total={total} pages={page_count}",
                            flush=True,
                        )
                        payload = None
                        records = None
                        derived_records = None
                        _release_ranking_combo_memory(
                            range_id=range_id,
                            view=view,
                            metric=metric,
                            scope_key=scope_key,
                            builder=builder,
                        )
                    derived_payload_template = None
                _release_completed_ranking_view_memory(
                    builder,
                    range_id=range_id,
                    view=view,
                )

        for range_id in RANGES:
            if not source_keys[range_id]:
                raise RuntimeError(f"ranking snapshot has no canonical source keys for {range_id}")
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
            affected_parent_sources = source_scope.affected_source_keys()
            unaffected_parent_video_sources = tuple(
                source_scope.unaffected_parent_video_sources()
            )
            preflight_parent_video_keys = (
                preflight_unaffected_parent_video_sources(
                    connection,
                    parent_revision_id=builder.parent[0],
                    sources=unaffected_parent_video_sources,
                )
                if unaffected_parent_video_sources else set()
            )
            exported_parent_sources = export_unaffected_parent_sources(
                connection,
                writer,
                parent_revision_id=builder.parent[0],
                source_keys=source_keys["all"],
                affected_source_keys=affected_parent_sources,
            )
            if not exported_parent_sources.issubset(source_keys["all"]):
                raise RuntimeError(
                    "parent source bulk export introduced an unknown source key"
                )
            bulk_exported_source_keys["all"].update(exported_parent_sources)
            parent_video_sources = tuple(
                item
                for item in unaffected_parent_video_sources
                if item[0] not in bulk_exported_source_keys["all"]
            )
            actual_parent_video_keys = {
                source_key for source_key, _video_id in parent_video_sources
            }
            if actual_parent_video_keys != preflight_parent_video_keys:
                raise RuntimeError(
                    "parent video source preflight changed inside snapshot: "
                    f"expected={len(preflight_parent_video_keys)} "
                    f"actual={len(actual_parent_video_keys)}"
                )
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
            affected_parent_sources = ()
            exported_parent_sources = set()
            unaffected_parent_video_sources = ()
            preflight_parent_video_keys = set()
            parent_video_sources = ()
        _release_materializer_memory(writer, builder, phase="source-scope")
        scoped_payload_loader = getattr(builder, "source_payload", None)
        for range_id in RANGES:
            if range_id in bulk_exported_ranges:
                continue
            pending_source_keys = sorted(
                source_keys[range_id] - bulk_exported_source_keys[range_id]
            )
            if range_id == "all" and getattr(builder, "generic_runtime", None):
                if pending_source_keys and (
                    source_scope is None
                    or not getattr(builder, "parent", None)
                    or not getattr(builder, "overlay_ids", ())
                ):
                    raise RuntimeError(
                        "generic all source batch has no exact overlay scope"
                    )
                exported_affected = export_affected_parent_sources(
                    connection,
                    writer,
                    parent_revision_id=builder.parent[0],
                    overlay_revision_ids=builder.overlay_ids,
                    source_scope=source_scope,
                    source_keys=pending_source_keys,
                ) if pending_source_keys else set()
                pending_source_keys = sorted(
                    set(pending_source_keys) - exported_affected
                )
                if pending_source_keys:
                    raise RuntimeError(
                        "generic all source batch left pending keys: "
                        + ", ".join(pending_source_keys[:10])
                    )
                continue
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

        for range_id in RANGES:
            derived_scope_counts = writer.derive_filtered_ranking_scopes(
                range_id=range_id,
                page_size=PAGE_SIZE,
            )
            overlap = sorted(set(scope_counts) & set(derived_scope_counts))
            if overlap:
                raise RuntimeError(
                    "derived filtered ranking series already exists: "
                    + ", ".join(overlap[:10])
                )
            scope_counts.update(derived_scope_counts)
            _release_materializer_memory(
                writer,
                builder,
                phase=f"filtered-rankings-{range_id}",
            )
        expected_scope_series = (
            len(RANGES) * len(VIEWS) * len(METRICS) * len(SCOPES)
        )
        if len(scope_counts) != expected_scope_series:
            raise RuntimeError(
                "ranking scope series is incomplete: "
                f"expected={expected_scope_series} actual={len(scope_counts)}"
            )

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
