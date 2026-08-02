#!/usr/bin/env python3
"""Emit a compact missing-field matrix for candidate enrichment JSONL."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def missing(value: Any) -> bool:
    return value is None or value == "" or value == []


def read_records(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError("enriched output contains a non-object")
            records.append(value)
    return records


def build_matrix(records: list[dict[str, Any]], sample_id: str) -> dict[str, Any]:
    field_paths = [
        "recordType",
        "schemaVersion",
        "videoId",
        "trialRoute",
        "releaseRoute",
        "releaseCutoffUtc",
        "eventTime",
        "channelId",
        "channelTitle",
        "songs",
        "detailPresent",
        "audit",
        "song.occurrenceId",
        "song.seconds",
        "song.title",
        "song.artist",
        "song.source.sourceId",
        "song.source.sourceHash",
        "song.source.rawHash",
        "song.source.sourcePath",
        "song.source.sourceSystem",
        "song.source.provenance",
    ]
    counts = {field: {"missing": 0, "present": 0} for field in field_paths}
    detail_null_count = 0
    empty_songs_count = 0
    needs_review_count = 0
    for record in records:
        if record.get("status") == "needs_review":
            needs_review_count += 1
        if record.get("detailPresent") is False:
            detail_null_count += 1
        songs = record.get("songs") if isinstance(record.get("songs"), list) else []
        if not songs:
            empty_songs_count += 1
        top_values = {field: record.get(field) for field in field_paths if "." not in field}
        for field, value in top_values.items():
            counts[field]["missing" if missing(value) else "present"] += 1
        if not songs:
            for field in field_paths:
                if field.startswith("song."):
                    counts[field]["missing"] += 1
        else:
            for song in songs:
                source = song.get("source") if isinstance(song.get("source"), dict) else {}
                song_values = {
                    "song.occurrenceId": song.get("occurrenceId"),
                    "song.seconds": song.get("seconds"),
                    "song.title": song.get("title"),
                    "song.artist": song.get("artist"),
                    "song.source.sourceId": source.get("sourceId"),
                    "song.source.sourceHash": source.get("sourceHash"),
                    "song.source.rawHash": source.get("rawHash"),
                    "song.source.sourcePath": source.get("sourcePath"),
                    "song.source.sourceSystem": source.get("sourceSystem"),
                    "song.source.provenance": source.get("provenance"),
                }
                for field, value in song_values.items():
                    counts[field]["missing" if missing(value) else "present"] += 1
    rows = [
        {
            "field": field,
            "missing": values["missing"],
            "present": values["present"],
            "total": values["missing"] + values["present"],
        }
        for field, values in counts.items()
    ]
    return {
        "matrixType": "luna-max-mac-enrichment-field-matrix",
        "schemaVersion": 1,
        "sampleId": sample_id,
        "recordCount": len(records),
        "needsReviewCount": needs_review_count,
        "detailNullCount": detail_null_count,
        "emptySongsCount": empty_songs_count,
        "rows": rows,
        "releaseEligible": False,
        "NOT_FOR_RELEASE": True,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--sample-id", required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    matrix = build_matrix(read_records(args.input), args.sample_id)
    args.out.write_text(json.dumps(matrix, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "needsReviewCount": matrix["needsReviewCount"], "emptySongsCount": matrix["emptySongsCount"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
