#!/usr/bin/env python3
"""Materialize compact ranking chunks directly from the canonical runtime SQLite DB.

This intentionally bypasses the old HTTP ranking API.  Release construction is
an offline read of one immutable runtime snapshot, so it must not spend tens of
seconds per page asking the production web server to deserialize the same rows.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sqlite3
import sys
import tempfile
from copy import deepcopy
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

CHUNK_SIZE = 200
DROP_RECORD_KEYS = frozenset(
    {"payload", "payload_json", "occurrence_payload_json", "video_payload_json"}
)
DROP_COMPACT_SCALARS = frozenset({"searchText"})
KEEP_COMPACT_LISTS = frozenset({"artists", "songs"})
OUTPUT_METRICS = ("occurrences", "songs", "videos")
DB_METRIC_CANDIDATES = {
    "occurrences": ("count", "occurrences"),
    "songs": ("songs",),
    "videos": ("videos",),
}


def _open_readonly(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA busy_timeout=30000")
    connection.execute("BEGIN")
    return connection


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        parsed = json.loads(value)
        if isinstance(parsed, dict):
            return parsed
    return {}


def _distinct_previews(occurrences: Iterable[Mapping[str, Any]], limit: int = 3) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in occurrences:
        if not isinstance(item, Mapping):
            continue
        nested = item.get("item") if isinstance(item.get("item"), Mapping) else {}
        video_id = str(item.get("videoId") or nested.get("videoId") or "")
        identity = f"video:{video_id}" if video_id else json.dumps(item, ensure_ascii=False, sort_keys=True)
        if identity in seen:
            continue
        seen.add(identity)
        preview = deepcopy(dict(item))
        for key in DROP_RECORD_KEYS:
            preview.pop(key, None)
        result.append(preview)
        if len(result) >= limit:
            break
    return result


def _compact_record(record: Mapping[str, Any], view: str) -> dict[str, Any]:
    compact: dict[str, Any] = {}
    for key, value in record.items():
        if key.startswith("_") or key in DROP_RECORD_KEYS or key in DROP_COMPACT_SCALARS:
            continue
        if key in KEEP_COMPACT_LISTS and isinstance(value, list):
            if view == "videos" and key == "songs":
                compact[key] = deepcopy(value[:3])
                compact["songPreviewCount"] = len(compact[key])
            elif view == "vtubers" and key == "songs":
                # The complete set belongs behind the source-detail endpoint.
                continue
            else:
                compact[key] = deepcopy(value)
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            compact[key] = deepcopy(value)
    occurrences = record.get("occurrences")
    previews = _distinct_previews(occurrences if isinstance(occurrences, list) else ())
    compact["occurrences"] = previews
    compact["sourcePreviewCount"] = len(previews)
    try:
        total = int(record.get("count") or record.get("timestampCount") or 0)
    except (TypeError, ValueError):
        total = 0
    compact["occurrencePreviewLimited"] = bool(
        record.get("occurrencePreviewLimited") or total > len(previews)
    )
    return compact


def _source_revision(connection: sqlite3.Connection) -> str:
    tables = {
        str(row[0])
        for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    if "meta" not in tables:
        return ""
    values = {str(row[0]): str(row[1]) for row in connection.execute("SELECT key, value FROM meta")}
    for key in ("active_revision_id", "activeRevisionId", "revision_id", "revisionId"):
        value = values.get(key, "").strip()
        if value:
            return value
    return ""


def _resolve_metric(
    connection: sqlite3.Connection, range_id: str, view: str, output_metric: str
) -> str | None:
    candidates = DB_METRIC_CANDIDATES.get(output_metric, (output_metric,))
    placeholders = ",".join("?" for _ in candidates)
    available = {
        str(row[0])
        for row in connection.execute(
            f"SELECT DISTINCT metric FROM ranking_rows "
            f"WHERE range_id=? AND view=? AND scope_key='all' AND metric IN ({placeholders})",
            (range_id, view, *candidates),
        )
    }
    for candidate in candidates:
        if candidate in available:
            return candidate
    return None


def _materialize_series(
    connection: sqlite3.Connection,
    output_root: Path,
    *,
    range_id: str,
    view: str,
    output_metric: str,
    db_metric: str,
) -> dict[str, Any]:
    summary = connection.execute(
        """
        SELECT count(*),
               coalesce(sum(count), 0),
               coalesce(sum(song_count), 0),
               coalesce(sum(video_count), 0)
        FROM ranking_rows
        WHERE range_id=? AND view=? AND metric=? AND scope_key='all'
        """,
        (range_id, view, db_metric),
    ).fetchone()
    total = int(summary[0] or 0)
    expected_pages = math.ceil(total / CHUNK_SIZE) if total else 0
    directory = output_root / "rankings" / range_id / view / output_metric
    directory.mkdir(parents=True, exist_ok=True)
    cursor = connection.execute(
        """
        SELECT rank, payload_json
        FROM ranking_rows
        WHERE range_id=? AND view=? AND metric=? AND scope_key='all'
        ORDER BY rank, row_id
        """,
        (range_id, view, db_metric),
    )
    page_number = 0
    records_written = 0
    while True:
        rows = cursor.fetchmany(CHUNK_SIZE)
        if not rows:
            break
        page_number += 1
        records: list[dict[str, Any]] = []
        for row in rows:
            record = _json_object(row["payload_json"])
            if not record:
                raise RuntimeError(
                    f"empty ranking payload: {range_id}/{view}/{db_metric} rank={row['rank']}"
                )
            record["rank"] = int(row["rank"] or record.get("rank") or 0)
            records.append(_compact_record(record, view))
        if page_number < expected_pages and len(records) != CHUNK_SIZE:
            raise RuntimeError(
                f"short middle page: {range_id}/{view}/{output_metric} "
                f"page={page_number} records={len(records)} expected={CHUNK_SIZE}"
            )
        payload = {
            "schemaVersion": 1,
            "rangeId": range_id,
            "view": view,
            "metric": output_metric,
            "page": page_number,
            "pageSize": CHUNK_SIZE,
            "totalCount": total,
            "filteredBaseCount": total,
            "totalOccurrenceCount": int(summary[1] or 0),
            "totalSongCount": int(summary[2] or 0),
            "totalVideoCount": int(summary[3] or 0),
            "pageCount": max(1, expected_pages),
            "compact": True,
            "records": records,
        }
        (directory / f"page-{page_number:04d}.json").write_text(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
            encoding="utf-8",
        )
        records_written += len(records)
    if records_written != total or page_number != expected_pages:
        raise RuntimeError(
            f"series completeness failure: {range_id}/{view}/{output_metric} "
            f"records={records_written}/{total} pages={page_number}/{expected_pages}"
        )
    return {
        "range": range_id,
        "view": view,
        "metric": output_metric,
        "dbMetric": db_metric,
        "records": records_written,
        "pages": page_number,
    }


def materialize(
    source_db: Path,
    output: Path,
    *,
    active_revision_id: str,
    ranges: Sequence[str] = ("7d", "all"),
    views: Sequence[str] = ("songs", "vtubers", "videos"),
    metrics: Sequence[str] = OUTPUT_METRICS,
) -> dict[str, Any]:
    if not source_db.is_file():
        raise FileNotFoundError(source_db)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    connection = _open_readonly(source_db)
    try:
        columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(ranking_rows)")}
        required = {
            "row_id", "range_id", "view", "metric", "scope_key", "rank",
            "count", "song_count", "video_count", "payload_json",
        }
        missing = sorted(required - columns)
        if missing:
            raise RuntimeError("ranking_rows missing columns: " + ", ".join(missing))
        source_revision = _source_revision(connection)
        if source_revision and source_revision != active_revision_id:
            raise RuntimeError(
                f"runtime DB revision mismatch: source={source_revision} expected={active_revision_id}"
            )
        series: list[dict[str, Any]] = []
        for range_id in ranges:
            for view in views:
                for output_metric in metrics:
                    db_metric = _resolve_metric(connection, range_id, view, output_metric)
                    if db_metric is None:
                        continue
                    item = _materialize_series(
                        connection,
                        staging,
                        range_id=range_id,
                        view=view,
                        output_metric=output_metric,
                        db_metric=db_metric,
                    )
                    if item["records"]:
                        series.append(item)
        if not series:
            raise RuntimeError("runtime DB produced no ranking series")
        expected_series = {
            (range_id, view, metric)
            for range_id in ranges
            for view in views
            for metric in metrics
        }
        present_series = {
            (str(item["range"]), str(item["view"]), str(item["metric"]))
            for item in series
        }
        missing_series = sorted(expected_series - present_series)
        if missing_series:
            formatted = ", ".join("/".join(parts) for parts in missing_series)
            raise RuntimeError("required ranking series missing or empty: " + formatted)
        if output.exists():
            shutil.rmtree(output)
        staging.replace(output)
        return {
            "activeRevisionId": active_revision_id,
            "sourceRevisionMarker": source_revision,
            "series": series,
            "records": sum(int(item["records"]) for item in series),
            "pages": sum(int(item["pages"]) for item in series),
        }
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    finally:
        connection.rollback()
        connection.close()


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-db", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--active-revision-id", required=True)
    parser.add_argument("--ranges", default="7d,all")
    parser.add_argument("--views", default="songs,vtubers,videos")
    parser.add_argument("--metrics", default=",".join(OUTPUT_METRICS))
    return parser.parse_args(argv)


def _split(value: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in value.split(",") if part.strip())


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        result = materialize(
            args.source_db,
            args.output,
            active_revision_id=args.active_revision_id,
            ranges=_split(args.ranges),
            views=_split(args.views),
            metrics=_split(args.metrics),
        )
    except Exception as exc:  # noqa: BLE001
        print(f"RANKING_MATERIALIZE_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print(
        "RANKING_MATERIALIZE_OK "
        + json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
