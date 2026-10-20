from __future__ import annotations

import importlib.util
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server" / "pg_adapter.py"


def load_adapter():
    spec = importlib.util.spec_from_file_location("candidate_pg_adapter_direct", SERVER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def direct_row(
    channel_id: str,
    video_id: str,
    occurrence_id: str,
    *,
    thumbnail_video_id: str | None = None,
    payload_channel_id: str | None = None,
    payload_handle: str | None = None,
    payload_url: str | None = None,
) -> dict:
    handle = "/@directfixture"
    channel_url = f"https://www.youtube.com/channel/{channel_id}"
    thumbnail_id = thumbnail_video_id or video_id
    video = {
        "videoId": video_id,
        "channelId": payload_channel_id or channel_id,
        "channelHandle": payload_handle or handle,
        "channelUrl": payload_url or channel_url,
        "thumbnailUrl": f"https://i.ytimg.com/vi/{thumbnail_id}/hqdefault.jpg",
    }
    return {
        "channel_id": channel_id,
        "channel_handle": handle,
        "channel_url": channel_url,
        "video_id": video_id,
        "occurrence_id": occurrence_id,
        "video_payload_json": video,
        "occurrence_payload_json": {
            "videoId": video_id,
            "occurrenceId": occurrence_id,
            "title": "direct fixture",
            "artist": "direct fixture artist",
            "seconds": 120,
        },
    }


def call(adapter, rows, channels):
    adapter._rows = lambda connection, sql, params=(): rows
    return adapter._bounded_direct_overlay_vtuber_previews(
        object(),
        ["overlay_revision"],
        channels,
        "all",
    )


def test_invalid_thumbnail_skips_only_that_channel() -> None:
    adapter = load_adapter()
    bad = direct_row(
        "UC-direct-bad",
        "video-bad",
        "occ-bad",
        thumbnail_video_id="video-other",
    )
    good = direct_row("UC-direct-good", "video-good", "occ-good")

    previews = call(adapter, [bad, good], ["UC-direct-bad", "UC-direct-good"])

    assert "UC-direct-bad" not in previews
    assert previews["UC-direct-good"]["video"]["videoId"] == "video-good"


def test_direct_identity_conflicts_still_raise() -> None:
    cases = (
        direct_row(
            "UC-channel-row",
            "video-channel",
            "occ-channel",
            payload_channel_id="UC-channel-other",
        ),
        direct_row(
            "UC-video-row",
            "video-row",
            "occ-video",
        ) | {
            "video_payload_json": {
                "videoId": "video-payload",
                "channelId": "UC-video-row",
                "channelHandle": "/@directfixture",
                "channelUrl": "https://www.youtube.com/channel/UC-video-row",
                "thumbnailUrl": "https://i.ytimg.com/vi/video-payload/hqdefault.jpg",
            }
        },
        direct_row(
            "UC-handle-row",
            "video-handle",
            "occ-handle",
            payload_handle="/@otherfixture",
        ),
        direct_row(
            "UC-url-row",
            "video-url",
            "occ-url",
            payload_url="https://www.youtube.com/channel/UC-url-other",
        ),
    )
    channels = [row["channel_id"] for row in cases]

    for row, channel_id in zip(cases, channels):
        adapter = load_adapter()
        try:
            call(adapter, [row], [channel_id])
        except adapter.PostgresAdapterError as exc:
            assert "invalid identity" in str(exc)
        else:
            raise AssertionError("direct identity conflict was silently skipped")


def main() -> None:
    tests = [
        test_invalid_thumbnail_skips_only_that_channel,
        test_direct_identity_conflicts_still_raise,
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
    print(
        "VTUBER_RANKING_P0_DIRECT_OVERLAY_FOLLOWUP_OK "
        f"tests={len(tests)} passed={len(tests)} failed=0"
    )


if __name__ == "__main__":
    main()
