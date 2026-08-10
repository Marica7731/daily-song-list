"""Materialize WDC ranking pages from one PostgreSQL repeatable-read snapshot.

The exporter runs next to the production PostgreSQL adapter as the database
peer user.  One read-only transaction fixes the active revision for the whole
export, so later parent-CAS activations cannot mix revisions across pages.
"""

from __future__ import annotations

import argparse
import gc
import json
import math
from pathlib import Path
from typing import Any, Callable, Mapping

import pg_adapter as adapter


RANGES = ("7d", "all")
VIEWS = ("songs", "vtubers", "videos")
METRICS = ("occurrences", "songs", "videos")
PAGE_SIZE = 200


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
            "latest_generated_at",
            "latestGeneratedAt",
            "generatedAt",
        ),
    }
    missing = [name for name, value in marker.items() if not value]
    if missing:
        raise RuntimeError("snapshot meta is missing: " + ", ".join(missing))
    return marker


def ranking_query(range_id: str, view: str, metric: str, page: int) -> dict[str, str]:
    return {
        "range": range_id,
        "view": view,
        "metric": metric,
        "page": str(page),
        "pageSize": str(PAGE_SIZE),
        "compact": "1",
    }


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


class SnapshotPageBuilder:
    def __init__(self, connection: Any):
        self.connection = connection
        self.generic_runtime = None
        self.parent = None
        self.overlay_ids: tuple[str, ...] = ()
        self.authoritative_ids: tuple[str, ...] = ()
        self.authoritative_records = None

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
    ) -> Callable[[int], Mapping[str, Any]]:
        if not self.generic_runtime:
            return lambda page: adapter.rankings_payload(
                self.connection,
                ranking_query(range_id, view, metric, page),
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
                ranking_query(range_id, view, metric, page),
            )

        first_query = ranking_query(range_id, view, metric, 1)
        options = adapter._query_options(first_query)
        prepared = adapter._prepare_generic_overlay_rankings(
            self.connection,
            revision_id,
            self.parent,
            options,
        )

        def render(page: int) -> Mapping[str, Any]:
            response = adapter._render_generic_overlay_rankings(
                self.connection,
                revision_id,
                prepared,
                ranking_query(range_id, view, metric, page),
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


def materialize(output_root: Path, meta_output: Path, expected_revision: str) -> dict[str, Any]:
    output_root.mkdir(parents=True, exist_ok=True)
    if any(output_root.iterdir()):
        raise RuntimeError(f"output directory is not empty: {output_root}")
    meta_output.parent.mkdir(parents=True, exist_ok=True)

    connection = adapter.connect_from_env()
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
        written = 0
        for range_id in RANGES:
            for view in VIEWS:
                for metric in METRICS:
                    render = builder.build_combo(range_id, view, metric)
                    first = dict(render(1))
                    total, page_count = validate_page(
                        first,
                        range_id=range_id,
                        view=view,
                        metric=metric,
                        page=1,
                    )
                    target_dir = output_root / "rankings" / range_id / view / metric
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
                        target = target_dir / f"page-{page:04d}.json"
                        target.write_text(
                            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                            encoding="utf-8",
                        )
                        written += 1
                        if written % 25 == 0:
                            print(f"PG_SNAPSHOT_WRITTEN files={written}", flush=True)
                    print(
                        f"PG_SNAPSHOT_COMBO {range_id}/{view}/{metric} "
                        f"total={total} pages={page_count}",
                        flush=True,
                    )
                    del render
                    gc.collect()

        after = canonical_meta(adapter.meta_payload(connection))
        for name in ("active_revision_id", "content_sha256", "source_commit_sha"):
            if after[name] != before[name]:
                raise RuntimeError(f"snapshot meta changed inside transaction: {name}")
        marker = {**before, "page_files": written}
        meta_output.write_text(
            json.dumps(marker, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
        )
        connection.rollback()
        print(f"PAGES_DONE files={written} revision={expected_revision}", flush=True)
        return marker
    except BaseException:
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
    parser.add_argument("--expected-revision", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    materialize(args.output, args.meta_output, args.expected_revision)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
