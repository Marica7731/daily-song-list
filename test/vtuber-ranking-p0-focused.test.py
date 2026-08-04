from __future__ import annotations

import importlib.util
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server" / "pg_adapter.py"


def load_adapter():
    spec = importlib.util.spec_from_file_location("candidate_pg_adapter", SERVER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def rank11_card() -> dict:
    channel_id = "UC9zLKU6WiRdcKtAh-6o_zmA"
    return {
        "key": channel_id,
        "channelId": channel_id,
        "name": "Muan ch.茨久あん",
        "count": 5785,
        "timestampCount": 5785,
        "songCount": 959,
        "videoCount": 340,
        "sourceDetailKey": "e566b5ab5d14e4a6",
        "occurrences": [],
    }


def rank12_card() -> dict:
    channel_id = "UCHjFUkpN2TYcUtqxaR8qpfQ"
    video_id = "R12Video001"
    item = {
        "videoId": video_id,
        "channelId": channel_id,
        "channelHandle": "/@rank12fixture",
        "thumbnailUrl": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
    }
    song = {"title": "rank12 fixture song", "artist": "rank12 fixture artist", "seconds": 180}
    return {
        "key": channel_id,
        "channelId": channel_id,
        "count": 5781,
        "timestampCount": 5781,
        "songCount": 958,
        "videoCount": 339,
        "sourceDetailKey": "rank12-fixture-source",
        "occurrences": [{
            "videoId": video_id,
            "item": item,
            "video": dict(item),
            "song": song,
            **song,
        }],
    }


def configure_render_fixture(adapter) -> None:
    adapter._apply_channel_metadata = lambda payload, row, metadata, range_id: payload
    adapter._hydrate_overlay_page_previews = lambda *args, **kwargs: None
    adapter._hydrate_runtime_ranking_song_previews = lambda *args, **kwargs: None
    adapter._bounded_direct_overlay_vtuber_previews = lambda *args, **kwargs: {}
    adapter._bounded_final_vtuber_previews = lambda *args, **kwargs: {}


def test_missing_preview_keeps_reviewed_scalars() -> None:
    adapter = load_adapter()
    card = rank11_card()

    adapter._mark_vtuber_preview_unavailable(card)
    adapter._canonicalize_vtuber_card_preview(card, card["channelId"])

    assert card["occurrences"] == []
    assert card["occurrencePreviewDegraded"] is True
    assert card["occurrencePreviewDiagnostic"] == "preview_unavailable"
    assert card["count"] == 5785
    assert card["timestampCount"] == 5785
    assert card["songCount"] == 959
    assert card["videoCount"] == 340
    assert card["sourceDetailKey"] == "e566b5ab5d14e4a6"


def test_identity_conflict_still_fails_even_when_preview_is_degraded() -> None:
    adapter = load_adapter()
    card = rank11_card()
    adapter._mark_vtuber_preview_unavailable(card)
    card["channelId"] = "UC-conflicting-channel"

    try:
        adapter._canonicalize_vtuber_card_preview(
            card, "UC9zLKU6WiRdcKtAh-6o_zmA"
        )
    except adapter.PostgresAdapterError as exc:
        assert str(exc) == "VTuber ranking preview identity is invalid"
    else:
        raise AssertionError("channel identity conflict was silently degraded")


def test_missing_parent_rows_are_a_subset_not_an_identity_error() -> None:
    adapter = load_adapter()
    adapter._rows = lambda connection, sql, params=(): []

    previews = adapter._bounded_final_vtuber_previews(
        object(),
        "full_runtime_30257210187_1",
        ["UC9zLKU6WiRdcKtAh-6o_zmA"],
        "all",
    )

    assert previews == {}


def test_returned_identity_conflict_still_fails() -> None:
    adapter = load_adapter()
    adapter._rows = lambda connection, sql, params=(): [
        {
            "channel_id": "UC-other",
            "video_id": "video-1",
            "occurrence_id": "occurrence-1",
            "video_payload_json": {
                "videoId": "video-1",
                "channelId": "UC-other",
                "thumbnailUrl": "https://i.ytimg.com/vi/video-1/hqdefault.jpg",
            },
            "occurrence_payload_json": {
                "videoId": "video-1",
                "occurrenceId": "occurrence-1",
            },
        }
    ]

    try:
        adapter._bounded_final_vtuber_previews(
            object(),
            "full_runtime_30257210187_1",
            ["UC9zLKU6WiRdcKtAh-6o_zmA"],
            "all",
        )
    except adapter.PostgresAdapterError as exc:
        assert str(exc) == "bounded VTuber preview query returned an inexact channel set"
    else:
        raise AssertionError("returned channel identity conflict was degraded")


def test_invalid_thumbnail_degrades_without_identity_change() -> None:
    adapter = load_adapter()
    for thumbnail in (
        "https://i.ytimg.com/vi/OtherVideo01/hqdefault.jpg",
        "",
    ):
        card = rank12_card()
        original = {
            key: card[key]
            for key in ("key", "channelId", "count", "timestampCount", "songCount", "videoCount", "sourceDetailKey")
        }
        occurrence = card["occurrences"][0]
        occurrence["item"]["thumbnailUrl"] = thumbnail
        occurrence["video"]["thumbnailUrl"] = thumbnail

        adapter._canonicalize_vtuber_card_preview(card, card["channelId"])

        assert card["occurrences"] == []
        assert card["occurrencePreviewDegraded"] is True
        assert card["occurrencePreviewDiagnostic"] == "thumbnail_unavailable"
        for key, value in original.items():
            assert card[key] == value


def test_non_identity_preview_payload_degrades() -> None:
    adapter = load_adapter()
    card = rank12_card()
    card["occurrences"][0]["song"]["title"] = "payload title mismatch"

    adapter._canonicalize_vtuber_card_preview(card, card["channelId"])

    assert card["occurrences"] == []
    assert card["occurrencePreviewDegraded"] is True
    assert card["occurrencePreviewDiagnostic"] == "preview_payload_invalid"
    assert card["count"] == 5781
    assert card["songCount"] == 958
    assert card["videoCount"] == 339
    assert card["sourceDetailKey"] == "rank12-fixture-source"


def test_channel_video_handle_url_identity_conflicts_still_fail() -> None:
    adapter = load_adapter()

    cases = []
    video_conflict = rank12_card()
    video_conflict["occurrences"][0]["video"]["videoId"] = "OtherVideo01"
    cases.append(video_conflict)

    handle_conflict = rank12_card()
    handle_conflict["occurrences"][0]["video"]["channelHandle"] = "/@otherfixture"
    cases.append(handle_conflict)

    url_conflict = rank12_card()
    url_conflict["occurrences"][0]["item"]["channelUrl"] = (
        "https://www.youtube.com/channel/UC-other"
    )
    cases.append(url_conflict)

    for card in cases:
        try:
            adapter._canonicalize_vtuber_card_preview(card, card["channelId"])
        except adapter.PostgresAdapterError as exc:
            assert str(exc) in {
                "VTuber ranking preview identity is invalid",
                "VTuber ranking preview channel URL is invalid",
            }
        else:
            raise AssertionError("channel/video/handle/url identity conflict was degraded")


def test_channel_search_thumbnail_fixture_does_not_503() -> None:
    adapter = load_adapter()
    configure_render_fixture(adapter)
    card = rank12_card()
    card["occurrences"][0]["item"]["thumbnailUrl"] = (
        "https://i.ytimg.com/vi/OtherVideo01/hqdefault.jpg"
    )
    card["occurrences"][0]["video"]["thumbnailUrl"] = (
        "https://i.ytimg.com/vi/OtherVideo01/hqdefault.jpg"
    )
    row = {
        "detail_key": card["channelId"],
        "row_count": card["count"],
        "song_count": card["songCount"],
        "video_count": card["videoCount"],
        "timestamp_count": card["timestampCount"],
        "payload_json": card,
    }

    result = adapter._render_generic_overlay_rankings(
        None,
        "accepted_30903093948_1",
        {
            "filtered": [row],
            "metadata": {},
            "candidateRows": (),
            "parentRevisionId": "full_runtime_30257210187_1",
            "aggregateTotals": {
                "totalCount": 1,
                "totalOccurrenceCount": card["count"],
                "totalSongCount": card["songCount"],
                "totalVideoCount": card["videoCount"],
            },
        },
        {
            "range": "all",
            "view": "vtubers",
            "metric": "videos",
            "page": 1,
            "pageSize": 20,
            "q": "@shingames7857",
            "searchFields": "channel",
            "compact": 1,
        },
    )

    assert result["page"] == 1
    assert result["pageSize"] == 20
    assert len(result["records"]) == 1
    record = result["records"][0]
    assert record["count"] == card["count"]
    assert record["songCount"] == card["songCount"]
    assert record["videoCount"] == card["videoCount"]
    assert record["sourceDetailKey"] == card["sourceDetailKey"]
    assert record["occurrences"] == []
    assert record["occurrencePreviewDiagnostic"] == "thumbnail_unavailable"


def test_page_one_thirty_preserves_rank_counts_and_rank12_preview() -> None:
    adapter = load_adapter()
    configure_render_fixture(adapter)

    rows = []
    expected_counts = {}
    for rank in range(1, 31):
        channel_id = (
            "UC9zLKU6WiRdcKtAh-6o_zmA"
            if rank == 11
            else "UCHjFUkpN2TYcUtqxaR8qpfQ"
            if rank == 12
            else f"UCfixture-channel-{rank:02d}"
        )
        payload = rank11_card() if rank == 11 else rank12_card() if rank == 12 else {
            "key": channel_id,
            "channelId": channel_id,
            "occurrences": [],
        }
        count = payload.get("count", 1000 + rank)
        timestamp_count = payload.get("timestampCount", count)
        song_count = payload.get("songCount", 100 + rank)
        video_count = payload.get("videoCount", 50 + rank)
        payload.update({
            "count": count,
            "timestampCount": timestamp_count,
            "songCount": song_count,
            "videoCount": video_count,
        })
        expected_counts[rank] = (count, timestamp_count, song_count, video_count)
        rows.append({
            "detail_key": channel_id,
            "row_count": count,
            "song_count": song_count,
            "video_count": video_count,
            "timestamp_count": timestamp_count,
            "payload_json": payload,
        })

    prepared = {
        "filtered": rows,
        "metadata": {},
        "candidateRows": (),
        "parentRevisionId": "full_runtime_30257210187_1",
        "aggregateTotals": {
            "totalCount": 30,
            "totalOccurrenceCount": sum(row["row_count"] for row in rows),
            "totalSongCount": sum(row["song_count"] for row in rows),
            "totalVideoCount": sum(row["video_count"] for row in rows),
        },
    }
    result = adapter._render_generic_overlay_rankings(
        None,
        "accepted_30903093948_1",
        prepared,
        {
            "range": "all",
            "view": "vtubers",
            "metric": "occurrences",
            "page": 1,
            "pageSize": 30,
            "compact": 1,
        },
    )

    assert result["page"] == 1
    assert result["pageSize"] == 30
    assert result["totalCount"] == 30
    assert len(result["records"]) == 30
    for record in result["records"]:
        rank = record["rank"]
        assert (
            record["count"],
            record["timestampCount"],
            record["songCount"],
            record["videoCount"],
        ) == expected_counts[rank]

    rank11 = result["records"][10]
    assert rank11["channelId"] == "UC9zLKU6WiRdcKtAh-6o_zmA"
    assert rank11["occurrences"] == []
    assert rank11["occurrencePreviewDegraded"] is True
    assert rank11["sourceDetailKey"] == "e566b5ab5d14e4a6"

    rank12 = result["records"][11]
    assert rank12["channelId"] == "UCHjFUkpN2TYcUtqxaR8qpfQ"
    assert len(rank12["occurrences"]) == 1
    assert "occurrencePreviewDegraded" not in rank12


def main() -> None:
    tests = [
        test_missing_preview_keeps_reviewed_scalars,
        test_identity_conflict_still_fails_even_when_preview_is_degraded,
        test_missing_parent_rows_are_a_subset_not_an_identity_error,
        test_returned_identity_conflict_still_fails,
        test_invalid_thumbnail_degrades_without_identity_change,
        test_non_identity_preview_payload_degrades,
        test_channel_video_handle_url_identity_conflicts_still_fail,
        test_channel_search_thumbnail_fixture_does_not_503,
        test_page_one_thirty_preserves_rank_counts_and_rank12_preview,
    ]
    failures = []
    for test in tests:
        try:
            test()
        except Exception as exc:  # pragma: no cover - test runner boundary
            failures.append(f"{test.__name__}: {exc}")
    if failures:
        for failure in failures:
            print(failure)
        raise SystemExit(1)
    print(f"VTUBER_RANKING_P0_FOCUSED_OK tests={len(tests)} passed={len(tests)} failed=0")


if __name__ == "__main__":
    main()
