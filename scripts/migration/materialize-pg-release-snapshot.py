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
from typing import Any, Callable, Iterable, Mapping, Sequence

import pg_adapter as adapter


RANGES = ("7d", "all")
VIEWS = ("songs", "artists", "vtubers", "videos")
METRICS = ("occurrences", "songs", "videos")
PAGE_SIZE = 200
SCOPES = (
    ("all", False, False),
    ("niche", True, False),
    ("visible", False, True),
    ("visibleNiche", True, True),
)
MAX_RANKING_SEARCH_CHARS = 65_536
MAX_CHANNEL_SEARCH_CHARS = 32_768
MAX_SOURCE_SEARCH_CHARS = 65_536


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


def _integer(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _bounded_text(parts: Iterable[Any], limit: int) -> str:
    values: list[str] = []
    seen: set[str] = set()
    size = 0
    for raw in parts:
        value = _text(raw)
        if not value or value in seen:
            continue
        seen.add(value)
        remaining = limit - size - (1 if values else 0)
        if remaining <= 0:
            break
        value = value[:remaining]
        values.append(value)
        size += len(value) + (1 if len(values) > 1 else 0)
    return " ".join(values)[:limit]


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
        _json_text(dict(record)),
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
    artist = _text(song.get("artist") or item.get("artist") or item.get("songArtist"))
    explicit_unknown = item.get("isUnknownArtist")
    if explicit_unknown is None:
        explicit_unknown = song.get("isUnknownArtist")
    is_unknown = bool(explicit_unknown) if explicit_unknown is not None else not bool(artist)
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
          is_unknown_artist INTEGER NOT NULL,search_text TEXT NOT NULL,payload_json TEXT NOT NULL,
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
        """)
        self.ranking_rows = 0
        self.source_details = 0
        self.source_occurrences = 0

    def add_ranking(self, row: Sequence[Any]) -> None:
        self.connection.execute(
            "INSERT INTO ranking_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            tuple(row),
        )
        self.ranking_rows += 1

    def add_source(
        self,
        source_key: str,
        range_id: str,
        record: Mapping[str, Any],
        occurrences: Sequence[Mapping[str, Any]],
    ) -> None:
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
        rows = [
            _source_occurrence_row(source_key, range_id, position, raw)
            for position, raw in enumerate(occurrences, start=1)
        ]
        self.connection.executemany(
            "INSERT INTO source_occurrences VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
        self.source_occurrences += len(rows)
        source_search = _bounded_text(
            (row[13] for row in rows),
            MAX_RANKING_SEARCH_CHARS,
        )
        channel_search = _bounded_text(
            (
                value
                for row in rows
                for value in (row[5], row[6], row[7], row[8])
            ),
            MAX_CHANNEL_SEARCH_CHARS,
        )
        self.connection.execute(
            """
            UPDATE ranking_rows
            SET search_text=substr(trim(search_text || ' ' || ?),1,?),
                channel_search_text=substr(trim(channel_search_text || ' ' || ?),1,?)
            WHERE range_id=? AND detail_key=?
            """,
            (
                source_search,
                MAX_RANKING_SEARCH_CHARS,
                channel_search,
                MAX_CHANNEL_SEARCH_CHARS,
                range_id,
                source_key,
            ),
        )

    def add_meta(self, values: Mapping[str, Any]) -> None:
        self.connection.executemany(
            "INSERT INTO meta(key,value) VALUES(?,?)",
            sorted((str(key), str(value)) for key, value in values.items()),
        )

    def finish(self) -> dict[str, Any]:
        quick = str(self.connection.execute("PRAGMA quick_check").fetchone()[0])
        if quick.casefold() != "ok":
            raise RuntimeError(f"canonical snapshot quick_check failed: {quick}")
        self.connection.commit()
        self.connection.close()
        os.replace(self.temp, self.output)
        return {
            "ranking_rows": self.ranking_rows,
            "source_details": self.source_details,
            "source_occurrences": self.source_occurrences,
            "snapshot_bytes": self.output.stat().st_size,
            "quick_check": quick,
        }

    def abort(self) -> None:
        try:
            self.connection.close()
        finally:
            self.temp.unlink(missing_ok=True)


def _source_query(range_id: str, page: int) -> dict[str, str]:
    return {
        "range": range_id,
        "page": str(page),
        "pageSize": str(PAGE_SIZE),
    }


def export_source(
    connection: Any,
    writer: CanonicalSnapshotWriter,
    *,
    range_id: str,
    source_key: str,
) -> None:
    occurrences: list[dict[str, Any]] = []
    seen_videos: set[str] = set()
    expected_page_count: int | None = None
    expected_video_count: int | None = None
    expected_occurrence_count: int | None = None
    detail: dict[str, Any] = {}
    page = 1
    while expected_page_count is None or page <= expected_page_count:
        payload = dict(adapter.source_payload(
            connection,
            source_key,
            _source_query(range_id, page),
        ))
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
        if _integer(payload.get("pageSize")) != PAGE_SIZE:
            raise RuntimeError(f"source page size changed: {range_id}/{source_key}/{page}")
        if expected_page_count is None:
            expected_page_count = page_count
            expected_video_count = video_count
            expected_occurrence_count = occurrence_count
            detail = current_detail
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
        occurrences.extend(dict(item) for item in page_occurrences if isinstance(item, Mapping))
        page += 1
    if len(seen_videos) != expected_video_count:
        raise RuntimeError(
            f"source video total mismatch: {range_id}/{source_key} "
            f"expected={expected_video_count} actual={len(seen_videos)}"
        )
    if len(occurrences) != expected_occurrence_count:
        raise RuntimeError(
            f"source occurrence total mismatch: {range_id}/{source_key} "
            f"expected={expected_occurrence_count} actual={len(occurrences)}"
        )
    writer.add_source(source_key, range_id, detail, occurrences)


class SnapshotPageBuilder:
    def __init__(self, connection: Any):
        self.connection = connection
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
            tuple[str, str, str, str], tuple[int, int, int]
        ] = {}

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
        )

        def render(page: int) -> Mapping[str, Any]:
            response = adapter._render_generic_overlay_rankings(
                self.connection,
                revision_id,
                prepared,
                ranking_query(range_id, view, metric, page, scope_key),
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
                                        f"ranking record is not an object: {series_key}/{page}/{index}"
                                    )
                                expected_rank = (page - 1) * PAGE_SIZE + index
                                writer.add_ranking(_ranking_row(
                                    raw,
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
                                compact_payload["records"] = adapter.compact_ranking_payloads(
                                    [dict(record) for record in records],
                                    view,
                                )
                                compact_payload["compact"] = True
                                target = target_dir / f"page-{page:04d}.json"
                                target.write_text(
                                    _json_text(compact_payload),
                                    encoding="utf-8",
                                )
                                written += 1
                                if written % 25 == 0:
                                    print(f"PG_SNAPSHOT_WRITTEN files={written}", flush=True)
                        print(
                            f"PG_SNAPSHOT_COMBO {range_id}/{view}/{metric}/{scope_key} "
                            f"total={total} pages={page_count}",
                            flush=True,
                        )
                        del render
                        gc.collect()

        for range_id in RANGES:
            missing = sorted(scoped_source_keys[range_id] - source_keys[range_id])
            if missing:
                raise RuntimeError(
                    f"filtered ranking introduced unknown source keys for {range_id}: "
                    + ", ".join(missing[:10])
                )
            if not source_keys[range_id]:
                raise RuntimeError(f"ranking snapshot has no canonical source keys for {range_id}")
            for index, source_key in enumerate(sorted(source_keys[range_id]), start=1):
                export_source(
                    connection,
                    writer,
                    range_id=range_id,
                    source_key=source_key,
                )
                if index % 25 == 0:
                    print(
                        f"PG_SNAPSHOT_SOURCES range={range_id} "
                        f"complete={index} total={len(source_keys[range_id])}",
                        flush=True,
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
        })
        snapshot_stats = writer.finish()
        snapshot_finished = True
        marker = {
            **before,
            "page_files": written,
            "ranking_scope_series": len(scope_counts),
            "ranking_scope_counts": scope_counts,
            "source_ranges": range_stats,
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
