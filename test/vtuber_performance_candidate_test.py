from __future__ import annotations

from copy import deepcopy
import json
import importlib.util
import inspect
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
def _load_product_adapter():
    server_root = ROOT / "server"
    sys.path.insert(0, str(server_root))
    try:
        spec = importlib.util.spec_from_file_location(
            "candidate_pg_adapter",
            server_root / "pg_adapter.py",
        )
        assert spec is not None and spec.loader is not None
        adapter = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = adapter
        spec.loader.exec_module(adapter)
        return adapter
    finally:
        sys.path.pop(0)


MODULE = _load_product_adapter()


def _load_generated_adapter():
    return MODULE


class _SpyCursor:
    description = (("detail_key",), ("prepared_rank",))

    def __init__(self) -> None:
        self.sql = ""
        self.params = ()
        self._values = []

    def execute(self, sql, params) -> None:
        self.sql = sql
        self.params = tuple(params)
        plan = json.loads(self.params[0])
        limit = int(self.params[-2])
        offset = int(self.params[-1])
        self._values = [
            (item["detail_key"], item["prepared_rank"])
            for item in plan[offset:offset + limit]
        ]

    def fetchall(self):
        return self._values

    def close(self) -> None:
        return None


class _SpyConnection:
    def __init__(self) -> None:
        self.cursor_instance = _SpyCursor()

    def cursor(self):
        return self.cursor_instance


def test_compact_card_is_scalar_and_has_three_distinct_sources() -> None:
    occurrences = [
        {"sourceId": "a", "occurrenceId": "a-1", "payload_json": {"full": True}},
        {"sourceId": "a", "occurrenceId": "a-2"},
        {"sourceId": "b", "occurrenceId": "b-1"},
        {"sourceId": "c", "occurrenceId": "c-1"},
        {"sourceId": "d", "occurrenceId": "d-1"},
    ]
    card = MODULE.compact_vtuber_ranking_card({
        "type": "vtuber",
        "key": "UC1",
        "count": 5,
        "songs": [{"title": "must stay in detail"}],
        "occurrences": occurrences,
        "payload_json": {"full": True},
    })
    assert card["key"] == "UC1"
    assert "songs" not in card and "payload_json" not in card
    assert len(card["occurrences"]) == 3
    assert [item["sourceId"] for item in card["occurrences"]] == ["a", "b", "c"]
    assert card["occurrencePreviewLimited"] is True
    assert all("payload_json" not in item for item in card["occurrences"])
    assert isinstance(card["count"], int)


def test_preparation_key_ignores_pagination_but_tracks_filter() -> None:
    base = {
        "range": "all", "view": "vtubers", "metric": "count",
        "q": "", "searchScope": "all", "searchFields": [],
        "minCount": 1, "nicheOnly": False, "hideUnknownArtist": False,
        "page": 1, "pageSize": 10,
    }
    other_page = {**base, "page": 9, "pageSize": 100}
    other_filter = {**base, "q": "needle"}
    assert MODULE.preparation_cache_key("active", base) == MODULE.preparation_cache_key("active", other_page)
    assert MODULE.preparation_cache_key("active", base) != MODULE.preparation_cache_key("active", other_filter)


def test_vtuber_cached_preparation_is_scalar_and_pagination_is_sql_only() -> None:
    cached = MODULE.scalar_preparation({
        "filtered": ({"detail_key": "UC1", "row_count": 3, "payload_json": {"occurrences": [1, 2, 3]}},),
        "candidateRows": ({"video_id": "v1", "occurrence_payload_json": {"secret": True}},),
        "clickedSongScopes": {"song": {"occurrences": ["secret"]}},
    }, view="vtubers")
    assert cached["filtered"][0]["payload_json"]["occurrences"] == []
    assert "occurrence_payload_json" not in cached["candidateRows"][0]
    assert cached["clickedSongScopes"] == {}
    assert MODULE.page_limit_offset(3, 20) == ("LIMIT %s OFFSET %s", (20, 40))


def test_generated_adapter_sql_page_slice_uses_scalar_plan_limit_offset() -> None:
    adapter = _load_generated_adapter()
    connection = _SpyConnection()
    rows = tuple(
        {
            "detail_key": f"channel-{index}",
            "payload_json": {"occurrences": [{"full": True}]},
        }
        for index in range(5)
    )
    page = adapter._sql_page_slice_prepared_rows(
        connection,
        rows,
        {"page": 2, "pageSize": 2},
    )
    assert [row["detail_key"] for row in page] == ["channel-2", "channel-3"]
    assert "jsonb_to_recordset" in connection.cursor_instance.sql
    assert "LIMIT %s OFFSET %s" in connection.cursor_instance.sql
    plan = json.loads(connection.cursor_instance.params[0])
    assert plan == [
        {"detail_key": f"channel-{index}", "prepared_rank": index}
        for index in range(5)
    ]
    assert connection.cursor_instance.params[-2:] == (2, 2)
    assert all("payload_json" not in item for item in plan)


def _overlay_only_vtuber_preparation() -> dict:
    previews = [
        {
            "videoId": f"video-{index}",
            "occurrenceId": f"occurrence-{index}",
            "position": index,
            "sourceId": f"source-{index}",
            "sourceDetailKey": f"source-detail-{index}",
            "item": {
                "videoId": f"video-{index}",
                "channelId": "UC-overlay-only",
                "channelHandle": "@overlay-only",
                "channelName": "Overlay Only",
            },
            "video": {
                "videoId": f"video-{index}",
                "channelId": "UC-overlay-only",
                "channelHandle": "@overlay-only",
            },
            "payload_json": {"must_not_be_cached": True},
        }
        for index in range(1, 5)
    ]
    payload = {
        "type": "vtuber",
        "key": "UC-overlay-only",
        "channelId": "UC-overlay-only",
        "channelName": "Overlay Only",
        "channelHandle": "@overlay-only",
        "name": "Overlay Only",
        "sourceDetailKey": "source-vtuber-7d-UC-overlay-only",
        "count": 4,
        "songCount": 4,
        "videoCount": 4,
        "timestampCount": 4,
        "occurrences": previews,
    }
    return {
        "filtered": ({
            "detail_key": "UC-overlay-only",
            "name": "Overlay Only",
            "row_count": 4,
            "song_count": 4,
            "video_count": 4,
            "timestamp_count": 4,
            "payload_json": payload,
            "_deferred_candidate_previews": previews[:1],
            "_deferred_runtime_preview_changes": [{
                "videoId": "video-1",
                "occurrenceId": "occurrence-1",
                "replacementPayload": {"must_not_be_cached": True},
            }],
            "occurrence_payload_json": {"full": True},
            "video_payload_json": {"full": True},
        },),
        "candidateRows": (),
        "metadata": (),
        "clickedSongScopes": {},
    }


def _public_vtuber_identity(prepared: dict) -> tuple:
    payload = prepared["filtered"][0]["payload_json"]
    previews = tuple(
        (
            item.get("videoId"),
            item.get("occurrenceId"),
            item.get("sourceId"),
            item.get("sourceDetailKey"),
        )
        for item in payload["occurrences"]
    )
    return (
        payload.get("key"),
        payload.get("channelId"),
        payload.get("count"),
        payload.get("sourceDetailKey"),
        previews,
    )


def test_page_one_build_page_two_cache_hit_preserves_overlay_only_vtuber_card() -> None:
    adapter = _load_generated_adapter()
    prepared = _overlay_only_vtuber_preparation()
    options_page_one = {
        "range": "7d", "view": "vtubers", "metric": "count",
        "q": "", "searchScope": "all", "searchFields": [],
        "minCount": 1, "nicheOnly": False, "hideUnknownArtist": False,
        "page": 1, "pageSize": 1,
    }
    options_page_two = {**options_page_one, "page": 2}
    key_page_one = adapter._generic_ranking_preparation_key(
        "active", "parent", options_page_one,
    )
    key_page_two = adapter._generic_ranking_preparation_key(
        "active", "parent", options_page_two,
    )
    assert key_page_one == key_page_two
    adapter._GENERIC_RANKING_PREPARATION_CACHE.clear()
    builds = []

    def build_once() -> dict:
        builds.append(True)
        return deepcopy(prepared)

    page_one = adapter._cached_generic_ranking_preparation(
        key_page_one,
        build_once,
        view="vtubers",
    )
    page_two = adapter._cached_generic_ranking_preparation(
        key_page_two,
        build_once,
        view="vtubers",
    )
    assert len(builds) == 1
    fresh_identity = _public_vtuber_identity(page_one)
    cached_identity = _public_vtuber_identity(page_two)
    assert cached_identity[:4] == fresh_identity[:4]
    assert cached_identity[4] == fresh_identity[4][:3]
    assert len(page_two["filtered"][0]["payload_json"]["occurrences"]) <= 3
    assert "occurrence_payload_json" not in page_two["filtered"][0]
    assert "video_payload_json" not in page_two["filtered"][0]
    deferred = page_two["filtered"][0]["_deferred_runtime_preview_changes"]
    assert deferred[0]["videoId"] == "video-1"
    assert deferred[0]["occurrenceId"] == "occurrence-1"
    assert "replacementPayload" not in deferred[0]
    assert all("payload_json" not in item for item in page_two["filtered"][0]["payload_json"]["occurrences"])


def test_non_vtuber_cache_preserves_payload_and_clicked_song_scope() -> None:
    prepared = {
        "filtered": ({
            "detail_key": "song-1",
            "payload_json": {"key": "song-1", "occurrences": [{"sourceId": "source-1"}]},
            "_deferred_runtime_preview_changes": [{"videoId": "video-1", "occurrenceId": "occurrence-1"}],
        },),
        "candidateRows": ({"occurrence_payload_json": {"full": True}},),
        "clickedSongScopes": {"song-1": {"occurrences": [{"sourceId": "source-1"}]}},
    }
    cached = MODULE.scalar_preparation(prepared, view="songs")
    assert cached == prepared
    assert cached["filtered"][0]["payload_json"]["occurrences"]
    assert cached["clickedSongScopes"]["song-1"]["occurrences"]


def test_vtuber_adjacent_prefetch_is_off_and_other_views_remain_allowed() -> None:
    assert MODULE.adjacent_prefetch_allowed("vtuberRank") is False
    assert MODULE.adjacent_prefetch_allowed("songRank") is True


def test_generic_overlay_compacts_after_preview_hydration() -> None:
    source = inspect.getsource(MODULE._render_generic_overlay_rankings)
    canonical = source.index("_canonicalize_vtuber_card_preview(record, channel_id)")
    compact = source.index("records = [compact_vtuber_ranking_card(record) for record in records]")
    assert canonical < compact


def test_product_app_disables_vtuber_adjacent_prefetch() -> None:
    app = (ROOT / "assets" / "app.js").read_text(encoding="utf-8")
    assert 'if (result?.view === "vtuberRank") return;' in app
    assert 'if (result.view !== "vtuberRank")' in app



if __name__ == "__main__":
    tests = [
        test_compact_card_is_scalar_and_has_three_distinct_sources,
        test_preparation_key_ignores_pagination_but_tracks_filter,
        test_vtuber_cached_preparation_is_scalar_and_pagination_is_sql_only,
        test_generated_adapter_sql_page_slice_uses_scalar_plan_limit_offset,
        test_page_one_build_page_two_cache_hit_preserves_overlay_only_vtuber_card,
        test_non_vtuber_cache_preserves_payload_and_clicked_song_scope,
        test_vtuber_adjacent_prefetch_is_off_and_other_views_remain_allowed,
        test_generic_overlay_compacts_after_preview_hydration,
        test_product_app_disables_vtuber_adjacent_prefetch,
    ]
    for test in tests:
        test()
    print("VTUBER_PERFORMANCE_CANDIDATE_TESTS_OK")
