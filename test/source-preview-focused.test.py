from __future__ import annotations

import ast
import copy
import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server" / "pg_adapter.py"


def _load_helpers() -> dict[str, Any]:
    tree = ast.parse(SERVER.read_text(encoding="utf-8"), filename=str(SERVER))
    wanted = {
        "_ranking_preview_video_id",
        "_ranking_preview_target",
        "_merge_ranking_preview_items",
        "_hydrate_runtime_ranking_song_previews",
    }
    nodes: list[ast.AST] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted:
            nodes.append(node)
        elif isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "MAX_RANKING_PREVIEW_VIDEOS"
            for target in node.targets
        ):
            nodes.append(node)
    namespace: dict[str, Any] = {
        "Any": Any,
        "Mapping": Mapping,
        "Sequence": Sequence,
        "defaultdict": defaultdict,
        "MAX_RANKING_PREVIEW_VIDEOS": 3,
        "_text": lambda value: "" if value is None else str(value),
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SERVER), "exec"), namespace)
    return namespace


def _record(key: str, target: int, first_video: str) -> dict[str, Any]:
    return {
        "title": key,
        "count": 128,
        "videoCount": target,
        "timestampCount": 128,
        "distinctVideoCount": target,
        "rank": 1,
        "sourceDetailKey": f"source-{key}",
        "occurrences": [{"item": {"videoId": first_video}}],
    }


def _source_rows(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for record in records:
        key = record["sourceDetailKey"]
        target = int(record["distinctVideoCount"])
        for number in range(1, target + 2):
            video_id = f"{key}-v{number}"
            rows.append({
                "source_key": key,
                "position": number,
                "video_id": video_id,
                "payload_json": {"item": {"videoId": video_id}},
            })
    return rows


def test_batch_query_limits_three_distinct_videos_and_preserves_scalars() -> None:
    helpers = _load_helpers()
    records = [
        _record("one", 3, "one-v1"),
        _record("two", 2, "two-v1"),
        _record("three", 1, "three-v1"),
    ]
    fixture_rows = _source_rows(records)
    calls: list[tuple[str, list[Any]]] = []

    def rows(_connection: object, sql: str, params: Sequence[Any]) -> list[dict[str, Any]]:
        calls.append((sql, list(params)))
        return fixture_rows

    helpers["_rows"] = rows
    helpers["_runtime_source_occurrence"] = lambda row: dict(row["payload_json"])
    helpers["_hydrate_runtime_ranking_song_previews"](
        object(), "revision", "all", "songs", records
    )

    assert len(calls) == 1
    sql, params = calls[0]
    assert "WITH RECURSIVE" in sql
    assert "runtime_source_details" in sql
    assert "runtime_source_occurrences" in sql
    assert "DISTINCT ON (detail.source_key)" in sql
    assert "source_video_rank <= %s" in sql
    assert params[1:3] == ["revision", "all"]
    for record in records:
        ids = [item["item"]["videoId"] for item in record["occurrences"]]
        assert len(ids) == record["distinctVideoCount"]
        assert len(ids) == len(set(ids))
        assert record["count"] == 128
        assert record["timestampCount"] == 128


def test_sufficient_preview_and_non_song_view_do_not_query_sources() -> None:
    helpers = _load_helpers()
    record = _record("single", 1, "single-v1")
    calls: list[str] = []

    def rows(_connection: object, sql: str, _params: Sequence[Any]) -> list[dict[str, Any]]:
        calls.append(sql)
        return []

    helpers["_rows"] = rows
    helpers["_runtime_source_occurrence"] = lambda row: dict(row["payload_json"])
    helpers["_hydrate_runtime_ranking_song_previews"](
        object(), "revision", "all", "songs", [record]
    )
    helpers["_hydrate_runtime_ranking_song_previews"](
        object(), "revision", "all", "artists", [copy.deepcopy(record)]
    )
    assert calls == []


def test_lineage_query_is_fail_closed_for_recent_empty_authority() -> None:
    helpers = _load_helpers()
    fixture = _record("lineage", 3, "lineage-v1")
    source_rows = _source_rows([fixture])
    calls: list[tuple[str, list[Any]]] = []

    def rows(_connection: object, sql: str, params: Sequence[Any]) -> list[dict[str, Any]]:
        calls.append((sql, list(params)))
        return source_rows if params[1] == "parent-authority" else []

    helpers["_rows"] = rows
    helpers["_runtime_source_occurrence"] = lambda row: dict(row["payload_json"])
    parent_record = copy.deepcopy(fixture)
    helpers["_hydrate_runtime_ranking_song_previews"](
        object(), "parent-authority", "all", "songs", [parent_record]
    )
    assert len(parent_record["occurrences"]) == 3

    empty_record = copy.deepcopy(fixture)
    helpers["_hydrate_runtime_ranking_song_previews"](
        object(), "recent-empty-authority", "all", "songs", [empty_record]
    )
    assert [item["item"]["videoId"] for item in empty_record["occurrences"]] == ["lineage-v1"]
    assert len(calls) == 2
    assert all(
        marker in calls[0][0]
        for marker in (
            "WITH RECURSIVE",
            "runtime_source_details",
            "DISTINCT ON (detail.source_key)",
            "lineage.lineage_depth",
        )
    )


if __name__ == "__main__":
    test_batch_query_limits_three_distinct_videos_and_preserves_scalars()
    test_sufficient_preview_and_non_song_view_do_not_query_sources()
    test_lineage_query_is_fail_closed_for_recent_empty_authority()
    print("SOURCE_PREVIEW_FOCUSED_OK tests=3 passed=3 failed=0")
