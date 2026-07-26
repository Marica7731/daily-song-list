#!/usr/bin/env python3
"""Validate and apply user-managed video/song upserts to PostgreSQL.

The command accepts either grouped video operations or flat playlist JSONL
rows.  It is intentionally provenance-first: missing channel identity stays
NULL/pending and is never inferred from a display name.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sys
import uuid


UNKNOWN_ARTISTS = {"", "unknown", "n/a", "na", "none", "null", "未記載", "未记录", "不明", "-"}
TIME_RE = re.compile(r"^(?:(\d+):)?(\d{1,2}):(\d{2})$")


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def fail(message: str) -> "NoReturn":
    raise ValueError(message)


def normalize_text(value: object) -> str:
    return " ".join(str(value or "").strip().split())


def parse_seconds(value: object) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        fail("seconds must be a non-negative integer")
    if isinstance(value, (int, float)):
        seconds = int(value)
    else:
        raw = normalize_text(value)
        if raw.isdigit():
            seconds = int(raw)
        else:
            match = TIME_RE.match(raw)
            if not match:
                fail(f"invalid time/seconds value: {value!r}")
            hours, minutes, remainder = match.groups()
            seconds = (int(hours or 0) * 3600) + int(minutes) * 60 + int(remainder)
    if seconds < 0:
        fail("seconds must be non-negative")
    return seconds


def first(item: dict, *keys: str, default: object = None) -> object:
    for key in keys:
        if key in item and item[key] not in (None, ""):
            return item[key]
    return default


def load_input(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = [json.loads(line) for line in text.splitlines() if line.strip()]
    if isinstance(parsed, dict):
        for key in ("operations", "videos", "records", "items"):
            if isinstance(parsed.get(key), list):
                parsed = parsed[key]
                break
        else:
            parsed = [parsed]
    if not isinstance(parsed, list) or not all(isinstance(item, dict) for item in parsed):
        fail("input must be an object, array, or JSONL objects")
    return [dict(item) for item in parsed]


def build_operations(items: list[dict]) -> list[dict]:
    grouped: dict[str, dict] = {}
    for item in items:
        video_id = normalize_text(first(item, "videoId", "video_id", "youtubeVideoId"))
        if not video_id:
            fail("every row requires videoId/video_id/youtubeVideoId")
        operation = grouped.setdefault(
            video_id,
            {
                "videoId": video_id,
                "videoUrl": normalize_text(first(item, "videoUrl", "video_url", "sourceUrl", "source_url")),
                "title": normalize_text(first(item, "videoTitle", "video_title")),
                "publishedAt": first(item, "publishedAt", "published_at", "date"),
                "channel": {},
                "songs": [],
                "rangeId": normalize_text(first(item, "rangeId", "range_id", default="all")) or "all",
                "sourceSystem": normalize_text(first(item, "sourceSystem", "source_system", default="playlist")) or "playlist",
                "replaceVideo": bool(first(item, "replaceVideo", "replace_video", default=True)),
                "reason": normalize_text(first(item, "reason", default="user_provided_setlist")) or "user_provided_setlist",
                "reviewedBy": normalize_text(first(item, "reviewedBy", "reviewed_by", default="")),
            },
        )
        channel = operation["channel"]
        for out_key, keys in {
            "channelId": ("channelId", "channel_id"),
            "handle": ("channelHandle", "channel_handle", "handle"),
            "displayName": ("channelName", "channel_name", "channelDisplayName", "channel_display_name"),
            "channelUrl": ("channelUrl", "channel_url"),
        }.items():
            value = normalize_text(first(item, *keys))
            if value and not channel.get(out_key):
                channel[out_key] = value
        title = normalize_text(first(item, "songTitle", "song_title", "title", "song"))
        artist = normalize_text(first(item, "artist", "singer", "歌手"))
        if not title:
            fail(f"{video_id}: song title is empty")
        seconds = parse_seconds(first(item, "seconds", "startSeconds", "start_seconds", "start", "startTime", "start_time", "time", "開始時間"))
        if seconds is None:
            fail(f"{video_id}: {title}: seconds/start time is required")
        operation["songs"].append({"seconds": seconds, "title": title, "artist": artist})
    return [validate_operation(operation) for operation in grouped.values()]


def validate_operation(operation: dict) -> dict:
    video_id = normalize_text(operation.get("videoId"))
    songs = operation.get("songs")
    if not video_id or not isinstance(songs, list) or not songs:
        fail(f"{video_id or '<unknown>'}: songs must be a non-empty list")
    seen: set[int] = set()
    normalized_songs = []
    for song in songs:
        seconds = parse_seconds(song.get("seconds"))
        title = normalize_text(song.get("title"))
        artist = normalize_text(song.get("artist"))
        if seconds is None or not title:
            fail(f"{video_id}: each song requires title and seconds")
        if seconds in seen:
            fail(f"{video_id}: duplicate seconds={seconds}")
        seen.add(seconds)
        normalized_songs.append({"seconds": seconds, "title": title, "artist": artist})
    channel = operation.get("channel") if isinstance(operation.get("channel"), dict) else {}
    channel_id = normalize_text(channel.get("channelId"))
    handle = normalize_text(channel.get("handle"))
    if channel_id and not re.fullmatch(r"UC[0-9A-Za-z_-]{10,}", channel_id):
        fail(f"{video_id}: channelId has invalid shape")
    if handle and not handle.startswith("@"):
        fail(f"{video_id}: channel handle must start with @")
    return {
        "videoId": video_id,
        "videoUrl": normalize_text(operation.get("videoUrl")),
        "title": normalize_text(operation.get("title")),
        "publishedAt": operation.get("publishedAt"),
        "channel": {
            "channelId": channel_id,
            "handle": handle,
            "displayName": normalize_text(channel.get("displayName")),
            "channelUrl": normalize_text(channel.get("channelUrl")),
            "resolutionStatus": "verified" if channel_id and handle else "pending",
        },
        "songs": normalized_songs,
        "rangeId": normalize_text(operation.get("rangeId")) or "all",
        "sourceSystem": normalize_text(operation.get("sourceSystem")) or "playlist",
        "replaceVideo": bool(operation.get("replaceVideo", True)),
        "reason": normalize_text(operation.get("reason")) or "user_provided_setlist",
        "reviewedBy": normalize_text(operation.get("reviewedBy")),
    }


def song_key(title: str, artist: str) -> str:
    normalized = f"{normalize_text(title).casefold()}\x1f{normalize_text(artist).casefold()}"
    return "song:" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:32]


def occurrence_id(operation: dict, song: dict) -> str:
    raw = "\x00".join(
        [operation["rangeId"], operation["videoId"], str(song["seconds"]), operation["sourceSystem"], "playlist"]
    )
    return "occ:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:40]


def summary(operations: list[dict]) -> dict:
    return {
        "videos": len(operations),
        "songs": sum(len(operation["songs"]) for operation in operations),
        "withVerifiedChannel": sum(bool(operation["channel"]["channelId"] and operation["channel"]["handle"]) for operation in operations),
        "pendingChannel": sum(not (operation["channel"]["channelId"] and operation["channel"]["handle"]) for operation in operations),
        "ranges": sorted({operation["rangeId"] for operation in operations}),
    }


def apply_operations(operations: list[dict], dsn: str, schema_file: Path) -> dict:
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError("psycopg is required on Mac for PostgreSQL apply") from exc

    operation_id = str(uuid.uuid4())
    result = {"operationId": operation_id, "videos": 0, "songs": 0, "occurrences": 0, "deletedOccurrences": 0}
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(schema_file.read_text(encoding="utf-8"))
            cur.execute(
                "INSERT INTO curation_operations(operation_id, action, status, requested_by, reason, input_json) VALUES (%s, %s, %s, %s, %s, %s::jsonb)",
                (operation_id, "upsert_video", "pending", operations[0].get("reviewedBy", ""), operations[0].get("reason", ""), json.dumps(operations, ensure_ascii=False)),
            )
            affected: dict[str, set[str]] = {}
            for operation in operations:
                channel = operation["channel"]
                if channel["channelId"]:
                    cur.execute(
                        """
                        INSERT INTO channels(channel_id, handle, display_name, channel_url, resolution_status)
                        VALUES (%s, NULLIF(%s, ''), %s, %s, %s)
                        ON CONFLICT(channel_id) DO UPDATE SET
                          handle=COALESCE(NULLIF(EXCLUDED.handle, ''), channels.handle),
                          display_name=COALESCE(NULLIF(EXCLUDED.display_name, ''), channels.display_name),
                          channel_url=COALESCE(NULLIF(EXCLUDED.channel_url, ''), channels.channel_url),
                          resolution_status=CASE WHEN EXCLUDED.resolution_status='verified' THEN 'verified' ELSE channels.resolution_status END,
                          updated_at=now()
                        """,
                        (channel["channelId"], channel["handle"], channel["displayName"], channel["channelUrl"], channel["resolutionStatus"]),
                    )
                cur.execute(
                    """
                    INSERT INTO videos(video_id, title, channel_id, channel_name, channel_handle, channel_url, published_text, source_url, resolution_status, payload_json)
                    VALUES (%s, %s, NULLIF(%s, ''), %s, %s, %s, %s, %s, %s, %s::jsonb)
                    ON CONFLICT(video_id) DO UPDATE SET
                      title=COALESCE(NULLIF(EXCLUDED.title, ''), videos.title),
                      channel_id=COALESCE(EXCLUDED.channel_id, videos.channel_id),
                      channel_name=COALESCE(NULLIF(EXCLUDED.channel_name, ''), videos.channel_name),
                      channel_handle=COALESCE(NULLIF(EXCLUDED.channel_handle, ''), videos.channel_handle),
                      channel_url=COALESCE(NULLIF(EXCLUDED.channel_url, ''), videos.channel_url),
                      published_text=COALESCE(NULLIF(EXCLUDED.published_text, ''), videos.published_text),
                      source_url=COALESCE(NULLIF(EXCLUDED.source_url, ''), videos.source_url),
                      resolution_status=CASE WHEN EXCLUDED.resolution_status='verified' THEN 'verified' ELSE videos.resolution_status END,
                      payload_json=videos.payload_json || EXCLUDED.payload_json,
                      updated_at=now()
                    """,
                    (
                        operation["videoId"], operation["title"], channel["channelId"], channel["displayName"],
                        channel["handle"], channel["channelUrl"], str(operation.get("publishedAt") or ""), operation["videoUrl"],
                        channel["resolutionStatus"], json.dumps(operation, ensure_ascii=False),
                    ),
                )
                result["videos"] += 1
                range_id = operation["rangeId"]
                affected.setdefault(range_id, set())
                new_occurrence_ids: list[str] = []
                for song in operation["songs"]:
                    key = song_key(song["title"], song["artist"])
                    cur.execute(
                        """
                        INSERT INTO songs(song_key, title, artist, payload_json)
                        VALUES (%s, %s, %s, %s::jsonb)
                        ON CONFLICT(song_key) DO UPDATE SET
                          title=COALESCE(NULLIF(EXCLUDED.title, ''), songs.title),
                          artist=COALESCE(NULLIF(EXCLUDED.artist, ''), songs.artist),
                          payload_json=songs.payload_json || EXCLUDED.payload_json,
                          updated_at=now()
                        """,
                        (key, song["title"], song["artist"], json.dumps(song, ensure_ascii=False)),
                    )
                    occ_id = occurrence_id(operation, song)
                    new_occurrence_ids.append(occ_id)
                    cur.execute(
                        """
                        INSERT INTO occurrences(occurrence_id, range_id, video_id, song_key, seconds, source_system, source_id, title, artist, is_unknown_artist, payload_json)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                        ON CONFLICT(occurrence_id) DO UPDATE SET
                          range_id=EXCLUDED.range_id, video_id=EXCLUDED.video_id, song_key=EXCLUDED.song_key,
                          seconds=EXCLUDED.seconds, title=EXCLUDED.title, artist=EXCLUDED.artist,
                          is_unknown_artist=EXCLUDED.is_unknown_artist, payload_json=occurrences.payload_json || EXCLUDED.payload_json,
                          updated_at=now()
                        """,
                        (
                            occ_id, range_id, operation["videoId"], key, song["seconds"], operation["sourceSystem"], "playlist",
                            song["title"], song["artist"], song["artist"].casefold() in UNKNOWN_ARTISTS, json.dumps(song, ensure_ascii=False),
                        ),
                    )
                    affected[range_id].add(key)
                    result["songs"] += 1
                    result["occurrences"] += 1
                if operation["replaceVideo"]:
                    cur.execute(
                        "DELETE FROM occurrences WHERE range_id=%s AND video_id=%s AND source_system=%s AND occurrence_id <> ALL(%s)",
                        (range_id, operation["videoId"], operation["sourceSystem"], new_occurrence_ids),
                    )
                    result["deletedOccurrences"] += cur.rowcount
            for range_id, keys in affected.items():
                for key in keys:
                    cur.execute(
                        """
                        INSERT INTO song_aggregates(range_id, song_key, occurrence_count, video_count)
                        SELECT %s, song_key, COUNT(*), COUNT(DISTINCT video_id)
                        FROM occurrences WHERE range_id=%s AND song_key=%s
                        GROUP BY song_key
                        ON CONFLICT(range_id, song_key) DO UPDATE SET
                          occurrence_count=EXCLUDED.occurrence_count,
                          video_count=EXCLUDED.video_count,
                          updated_at=now()
                        """,
                        (range_id, range_id, key),
                    )
            result["status"] = "applied"
            cur.execute(
                "UPDATE curation_operations SET status=%s, result_json=%s::jsonb, applied_at=now() WHERE operation_id=%s",
                ("applied", json.dumps(result, ensure_ascii=False), operation_id),
            )
        conn.commit()
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--dsn", default="")
    parser.add_argument("--schema-file", type=Path, default=Path("deploy/postgres/schema.sql"))
    parser.add_argument("--apply", action="store_true", help="apply in one transaction; default is validation only")
    parser.add_argument("--output", type=Path, help="write normalized operations/summary JSON")
    return parser.parse_args()


def main() -> int:
    configure_stdio()
    args = parse_args()
    try:
        operations = build_operations(load_input(args.input))
        payload = {"summary": summary(operations), "operations": operations}
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("CODEX_POSTGRES_UPSERT_VALIDATE_OK " + json.dumps(payload["summary"], ensure_ascii=False))
        if args.apply:
            if not args.dsn:
                fail("--dsn is required with --apply")
            result = apply_operations(operations, args.dsn, args.schema_file)
            print("CODEX_POSTGRES_UPSERT_APPLY_OK " + json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(f"CODEX_POSTGRES_UPSERT_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
