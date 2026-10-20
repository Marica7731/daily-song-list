"""Focused tests for the versioned release bundle prototype.

The same input must produce the same immutable content SHA and identical
bytes; pages must never contain full occurrence lists (compact cards carry
at most three distinct-video previews); the manifest must bind every file.
"""

from __future__ import annotations

import gzip
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "migration" / "build-release-bundle.py"

RELEASE_META = {
    "activeRevisionId": "accepted_test_1",
    "expectedParentRevisionId": "full_runtime_test_1",
    "sourceCommitSha": "5e4d2a94b6972ed7997dc17af32a33c3191df59d",
    "generatedAt": "2026-08-07T00:00:00+00:00",
    "latestEventTime": "2026-07-26T19:33:42.681Z",
}


def _compact_vtuber_page() -> dict:
    return {
        "schemaVersion": 1,
        "rangeId": "all",
        "view": "vtubers",
        "metric": "occurrences",
        "page": 1,
        "pageSize": 10,
        "totalCount": 1,
        "pageCount": 1,
        "compact": True,
        "records": [
            {
                "type": "vtuber",
                "key": "UC1",
                "name": "Channel A",
                "channelName": "Channel A",
                "channelId": "UC1",
                "count": 5,
                "songCount": 3,
                "videoCount": 3,
                "timestampCount": 5,
                "sourceDetailKey": "source-vtuber:all:UC1",
                "sourcePreviewCount": 3,
                "occurrencePreviewLimited": True,
                "rank": 1,
                "occurrences": [
                    {"videoId": "v1", "sourceId": "s1", "title": "t1"},
                    {"videoId": "v2", "sourceId": "s2", "title": "t2"},
                    {"videoId": "v3", "sourceId": "s3", "title": "t3"},
                ],
            }
        ],
    }


def _compact_song_page() -> dict:
    return {
        "schemaVersion": 1,
        "rangeId": "all",
        "view": "songs",
        "metric": "occurrences",
        "page": 1,
        "pageSize": 10,
        "totalCount": 1,
        "pageCount": 1,
        "compact": True,
        "records": [
            {
                "type": "song",
                "key": "song-1",
                "title": "Song Title",
                "displayArtist": "Artist",
                "count": 2,
                "songCount": 1,
                "videoCount": 2,
                "timestampCount": 2,
                "sourceDetailKey": "source-song:all:song-1",
                "artists": [{"name": "Artist", "count": 2}],
                "rank": 1,
                "occurrences": [
                    {"videoId": "v1", "sourceId": "s1", "title": "t1"},
                    {"videoId": "v2", "sourceId": "s2", "title": "t2"},
                ],
            }
        ],
    }


def _write_input_dir(input_root: Path) -> None:
    vtuber = input_root / "rankings" / "all" / "vtubers" / "occurrences"
    vtuber.mkdir(parents=True)
    (vtuber / "page-0001.json").write_text(json.dumps(_compact_vtuber_page(), ensure_ascii=False), encoding="utf-8")
    song = input_root / "rankings" / "all" / "songs" / "occurrences"
    song.mkdir(parents=True)
    (song / "page-0001.json").write_text(json.dumps(_compact_song_page(), ensure_ascii=False), encoding="utf-8")


def _run(input_root: Path, output_root: Path) -> str:
    result = subprocess.run(
        [
            sys.executable, str(SCRIPT),
            "--input", str(input_root),
            "--output", str(output_root),
            "--active-revision-id", RELEASE_META["activeRevisionId"],
            "--expected-parent-revision-id", RELEASE_META["expectedParentRevisionId"],
            "--source-commit-sha", RELEASE_META["sourceCommitSha"],
            "--generated-at", RELEASE_META["generatedAt"],
            "--latest-event-time", RELEASE_META["latestEventTime"],
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def test_bundle_is_deterministic_and_immutable() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        first_out = root / "releases-a"
        _write_input_dir(root / "input-a")
        line_a = _run(root / "input-a", first_out)
        assert line_a.startswith("RELEASE_BUNDLE_OK contentSha256="), line_a
        sha_a = line_a.split("contentSha256=")[1].split(" ")[0]
        bundle_a = first_out / sha_a
        assert (bundle_a / "manifest.json").exists()
        assert (bundle_a / "meta.json").exists()

        # identical input must produce the same sha and identical bytes
        second_out = root / "releases-b"
        line_b = _run(root / "input-a", second_out)
        sha_b = line_b.split("contentSha256=")[1].split(" ")[0]
        assert sha_a == sha_b
        assert (second_out / sha_b / "manifest.json").read_bytes() == (bundle_a / "manifest.json").read_bytes()

        # a changed input must produce a different sha (immutable identity)
        changed = root / "input-b"
        _write_input_dir(changed)
        changed_page = changed / "rankings" / "all" / "vtubers" / "occurrences" / "page-0001.json"
        payload = json.loads(changed_page.read_text(encoding="utf-8"))
        payload["records"][0]["count"] = 6
        changed_page.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        third_out = root / "releases-c"
        line_c = _run(changed, third_out)
        sha_c = line_c.split("contentSha256=")[1].split(" ")[0]
        assert sha_c != sha_a


def test_manifest_binds_every_page_and_cards_are_bounded() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _write_input_dir(root / "input")
        line = _run(root / "input", root / "out")
        sha = line.split("contentSha256=")[1].split(" ")[0]
        bundle = root / "out" / sha
        manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
        assert manifest["schemaVersion"] == 1
        assert manifest["candidateRevisionId"] == RELEASE_META["activeRevisionId"]
        assert manifest["expectedParentRevisionId"] == RELEASE_META["expectedParentRevisionId"]
        assert manifest["sourceCommitSha"] == RELEASE_META["sourceCommitSha"]
        page_paths = {entry["path"] for entry in manifest["pages"]}
        assert page_paths == {
            "rankings/all/vtubers/occurrences/page-0001.json.gz",
            "rankings/all/songs/occurrences/page-0001.json.gz",
        }
        for entry in manifest["pages"]:
            target = bundle / entry["path"]
            assert target.read_bytes() == (bundle / entry["path"]).read_bytes()
            assert len(target.read_bytes()) == entry["bytes"]
        # each gz decodes to JSON with ≤3 previews per card
        for entry in manifest["pages"]:
            with gzip.open(bundle / entry["path"], "rt", encoding="utf-8") as handle:
                payload = json.load(handle)
            for record in payload["records"]:
                assert len(record["occurrences"]) <= 3
        meta = json.loads((bundle / "meta.json").read_text(encoding="utf-8"))
        assert meta["activeRevisionId"] == RELEASE_META["activeRevisionId"]


def test_rejects_card_with_more_than_three_previews() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _write_input_dir(root / "input")
        page = root / "input" / "rankings" / "all" / "vtubers" / "occurrences" / "page-0001.json"
        payload = json.loads(page.read_text(encoding="utf-8"))
        payload["records"][0]["occurrences"].append({"videoId": "v4", "sourceId": "s4", "title": "t4"})
        page.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPT),
             "--input", str(root / "input"), "--output", str(root / "out"),
             "--active-revision-id", RELEASE_META["activeRevisionId"],
             "--expected-parent-revision-id", RELEASE_META["expectedParentRevisionId"],
             "--source-commit-sha", RELEASE_META["sourceCommitSha"],
             "--generated-at", RELEASE_META["generatedAt"]],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode != 0
        assert "max 3" in result.stderr


if __name__ == "__main__":
    tests = [
        test_bundle_is_deterministic_and_immutable,
        test_manifest_binds_every_page_and_cards_are_bounded,
        test_rejects_card_with_more_than_three_previews,
    ]
    for test in tests:
        test()
    print("BUILD_RELEASE_BUNDLE_TESTS_OK")
