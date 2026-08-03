from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Any, Iterable, Mapping


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server" / "pg_adapter.py"


def _load_search_helpers() -> dict[str, Any]:
    tree = ast.parse(SERVER.read_text(encoding="utf-8"), filename=str(SERVER))
    wanted = {
        "_effective_search_fields",
        "_public_search_fields",
        "_runtime_row_search_texts",
        "_runtime_row_matches_search",
        "_public_row_matches_search",
    }
    nodes: list[ast.AST] = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in wanted:
            nodes.append(node)
        elif isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name)
            and target.id in {"_DEFAULT_SEARCH_FIELDS", "_ALL_SEARCH_FIELDS", "_SEARCH_FIELDS"}
            for target in node.targets
        ):
            nodes.append(node)

    def json_object(value: Any) -> dict[str, Any]:
        if isinstance(value, Mapping):
            return dict(value)
        if isinstance(value, str):
            parsed = json.loads(value)
            return dict(parsed) if isinstance(parsed, Mapping) else {}
        return {}

    def legacy_match(text: str, tokens: Iterable[str]) -> bool:
        folded = text.casefold()
        return all(str(token).casefold() in folded for token in tokens)

    namespace: dict[str, Any] = {
        "Any": Any,
        "Iterable": Iterable,
        "Mapping": Mapping,
        "_text": lambda value: "" if value is None else str(value),
        "_json_object": json_object,
        "_matches_search_tokens": legacy_match,
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SERVER), "exec"), namespace)
    return namespace


def _row(
    title: str,
    artist: str,
    channel: str,
    video_title: str,
    source_id: str,
) -> dict[str, Any]:
    payload = {
        "title": title,
        "displayArtist": artist,
        "occurrences": [{
            "item": {
                "videoId": "video-1",
                "title": video_title,
                "channelName": channel,
            },
            "song": {
                "title": title,
                "artist": artist,
                "sourceId": source_id,
                "sourceSystem": "youtube",
            },
        }],
    }
    return {
        "title": title,
        "artist": artist,
        "channel_search_text": channel,
        "search_text": f"{title} {artist} {video_title}",
        "payload_json": json.dumps(payload, ensure_ascii=False),
    }


def _options(*, view: str = "songs", fields: Any = None) -> dict[str, Any]:
    return {
        "view": view,
        "q": "快晴",
        "searchTokens": ("快晴",),
        "searchFields": fields,
        "searchScope": "song",
    }


def test_omitted_fields_use_song_default_title_artist_channel() -> None:
    helpers = _load_search_helpers()
    false_positive = _row("晴る", "ヨルシカ", "ordinary", "快晴 source video", "other-source")
    real_title = _row("快晴", "Orangestar", "ordinary", "別の映像", "real-source")
    options = _options()
    assert helpers["_effective_search_fields"](options) == ("title", "artist", "channel")
    assert helpers["_public_row_matches_search"](false_positive, options) is False
    assert helpers["_public_row_matches_search"](real_title, options) is True
    assert helpers["_public_search_fields"](options) == ["title", "artist", "channel"]


def test_video_and_source_are_payload_specific_fields() -> None:
    helpers = _load_search_helpers()
    video_row = _row("別曲", "Other", "ordinary", "快晴 source video", "other-source")
    source_row = _row("別曲", "Other", "ordinary", "別映像", "快晴-source")
    video_options = _options(fields=("video",))
    source_options = _options(fields=("source",))
    assert helpers["_public_row_matches_search"](video_row, video_options) is True
    assert helpers["_public_row_matches_search"](source_row, source_options) is True
    assert helpers["_public_row_matches_search"](
        _row("快晴", "Other", "ordinary", "別映像", "other-source"), video_options
    ) is False
    assert helpers["_public_search_fields"](video_options) == ["video"]
    assert helpers["_public_search_fields"](source_options) == ["source"]


def test_empty_fields_is_explicit_all_and_includes_video_source() -> None:
    helpers = _load_search_helpers()
    row = _row("別曲", "Other", "ordinary", "快晴 source video", "快晴-source")
    options = _options(fields=[])
    assert helpers["_effective_search_fields"](options) == (
        "title", "artist", "channel", "video", "source"
    )
    assert helpers["_public_row_matches_search"](row, options) is True
    assert helpers["_public_search_fields"](options) == [
        "title", "artist", "channel", "video", "source"
    ]


def test_non_song_view_keeps_legacy_aggregate_path() -> None:
    helpers = _load_search_helpers()
    row = _row("晴る", "ヨルシカ", "ordinary", "快晴 source video", "other-source")
    options = _options(view="artists")
    assert helpers["_public_row_matches_search"](row, options) is True
    assert helpers["_public_search_fields"](options) == []


if __name__ == "__main__":
    test_omitted_fields_use_song_default_title_artist_channel()
    test_video_and_source_are_payload_specific_fields()
    test_empty_fields_is_explicit_all_and_includes_video_source()
    test_non_song_view_keeps_legacy_aggregate_path()
    print("SEARCH_SCOPE_FOCUSED_OK tests=4 passed=4 failed=0")
