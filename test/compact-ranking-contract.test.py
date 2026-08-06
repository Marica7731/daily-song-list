"""Focused unit tests for the generalized compact ranking card contract.

The compact list contract keeps scalar fields, the stable source detail key
and at most three distinct-video previews.  Full occurrence/song payloads are
served by the source detail API.  The small count lists the compact card meta
reads directly (artists for songs, songs for artists/vtubers) are retained;
the megabyte-scale searchText and unbounded channels count list are dropped.
"""

from __future__ import annotations

import importlib.util
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


def _occurrence(video_id: str, source_id: str) -> dict:
    return {
        "videoId": video_id,
        "sourceId": source_id,
        "occurrenceId": f"occ-{video_id}",
        "title": f"title-{video_id}",
        "item": {"videoId": video_id},
    }


def test_song_compact_drops_searchtext_and_channels_keeps_artists() -> None:
    card = MODULE.compact_ranking_card(
        {
            "type": "song", "key": "song-1", "title": "T",
            "displayArtist": "A", "count": 5, "songCount": 3, "videoCount": 3,
            "timestampCount": 5, "sourceDetailKey": "source-song",
            "searchText": "x" * 1024 * 1024,
            "artists": [{"name": "A", "count": 5}],
            "channels": [{"name": f"ch-{i}", "count": 1} for i in range(400)],
            "occurrences": [_occurrence("v1", "s1"), _occurrence("v2", "s2"),
                            _occurrence("v3", "s3"), _occurrence("v4", "s4")],
        },
        "songs",
    )
    assert "searchText" not in card
    assert "channels" not in card
    assert card["artists"] == [{"name": "A", "count": 5}]
    assert len(card["occurrences"]) == 3
    assert {item["sourceId"] for item in card["occurrences"]} == {"s1", "s2", "s3"}
    assert card["sourcePreviewCount"] == 3
    assert card["occurrencePreviewLimited"] is True
    assert card["sourceDetailKey"] == "source-song"


def test_video_compact_trims_songs_to_preview_and_keeps_scalars() -> None:
    card = MODULE.compact_ranking_card(
        {
            "type": "video", "key": "v1", "videoId": "v1", "title": "V",
            "count": 123, "timestampCount": 123, "songCount": 0, "videoCount": 1,
            "sourceDetailKey": "source-video", "channelName": "C",
            "songs": [{"title": f"song-{i}", "artist": "A", "seconds": i, "isNiche": False}
                      for i in range(50)],
            "occurrences": [_occurrence("v1", "s1"), _occurrence("v1", "s2")],
        },
        "videos",
    )
    assert len(card["songs"]) == 3
    assert card["songPreviewCount"] == 3
    assert card["count"] == 123
    assert card["occurrencePreviewLimited"] is True  # 123 occurrences > 2 previews


def test_artist_compact_keeps_song_count_list() -> None:
    card = MODULE.compact_ranking_card(
        {
            "type": "artist", "key": "artist-1", "name": "A",
            "count": 4, "songCount": 2, "videoCount": 2, "timestampCount": 4,
            "sourceDetailKey": "source-artist",
            "songs": [{"name": "S1", "count": 3}, {"name": "S2", "count": 1}],
            "occurrences": [_occurrence("v1", "s1"), _occurrence("v2", "s2")],
        },
        "artists",
    )
    assert card["songs"] == [{"name": "S1", "count": 3}, {"name": "S2", "count": 1}]
    assert len(card["occurrences"]) == 2


def test_dispatcher_preserves_vtuber_three_preview_shape() -> None:
    records = [
        {
            "type": "vtuber", "key": "UC1", "name": "N", "channelName": "N",
            "channelId": "UC1", "count": 9, "songCount": 3, "videoCount": 3,
            "timestampCount": 9, "sourceDetailKey": "source-vtuber",
            "occurrences": [_occurrence("v1", "s1"), _occurrence("v2", "s2"),
                            _occurrence("v3", "s3"), _occurrence("v4", "s4")],
        }
    ]
    compact = MODULE.compact_ranking_payloads(records, "vtubers")
    assert len(compact) == 1
    assert len(compact[0]["occurrences"]) == 3
    assert compact[0]["occurrencePreviewLimited"] is True


def test_dispatcher_generalizes_non_vtuber_views() -> None:
    records = [
        {
            "type": "song", "key": "s1", "title": "T", "displayArtist": "A",
            "count": 2, "songCount": 1, "videoCount": 1, "timestampCount": 2,
            "sourceDetailKey": "source-song", "searchText": "x" * 100,
            "artists": [{"name": "A", "count": 2}],
            "channels": [{"name": "C", "count": 2}],
            "occurrences": [_occurrence("v1", "s1"), _occurrence("v2", "s2")],
        }
    ]
    compact = MODULE.compact_ranking_payloads(records, "songs")
    assert "searchText" not in compact[0]
    assert "channels" not in compact[0]
    assert len(compact[0]["occurrences"]) == 2


if __name__ == "__main__":
    tests = [
        test_song_compact_drops_searchtext_and_channels_keeps_artists,
        test_video_compact_trims_songs_to_preview_and_keeps_scalars,
        test_artist_compact_keeps_song_count_list,
        test_dispatcher_preserves_vtuber_three_preview_shape,
        test_dispatcher_generalizes_non_vtuber_views,
    ]
    for test in tests:
        test()
    print("COMPACT_RANKING_CONTRACT_TESTS_OK")
