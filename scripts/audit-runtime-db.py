#!/usr/bin/env python3
"""Extract a bounded, read-only quality report from a fully materialized runtime DB."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
from typing import Any
import unicodedata


YOSHIKA_CHANNEL_ID = "UC3xQCiEPSkco54WhuiDcngw"
YOSHIKA_HANDLE = "@yoshika-ch"


def main() -> int:
    configure_stdio()
    args = parse_args()
    try:
        db_path = args.db.resolve()
        if not db_path.is_file():
            raise FileNotFoundError(f"database not found: {db_path}")
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        quick_check = conn.execute("PRAGMA quick_check(1)").fetchone()[0]
        if quick_check != "ok":
            raise RuntimeError(f"SQLite quick_check failed: {quick_check}")
        report = {
            "schemaVersion": 1,
            "status": "complete",
            "db": {
                "bytes": db_path.stat().st_size,
                "sha256": sha256_file(db_path),
                "quickCheck": quick_check,
            },
            "meta": read_meta(conn),
            "tableCounts": read_table_counts(conn),
            "global": read_global_counts(conn),
            "yoshika": read_yoshika(conn),
            "pages": read_requested_pages(conn),
        }
        conn.close()
        write_json_atomic(args.output.resolve(), report)
    except Exception as exc:
        print(f"CODEX_RUNTIME_DB_AUDIT_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print(
        "CODEX_RUNTIME_DB_AUDIT_OK "
        f"db={args.db} bytes={report['db']['bytes']} "
        f"videos={report['global']['videos']} songs={report['global']['songs']} "
        f"occurrences={report['global']['occurrences']}"
    )
    return 0


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def read_meta(conn: sqlite3.Connection) -> dict[str, str]:
    return {
        row["key"]: row["value"]
        for row in conn.execute("SELECT key, value FROM meta ORDER BY key")
    }


def read_table_counts(conn: sqlite3.Connection) -> dict[str, int]:
    result = {}
    for table in (
        "videos",
        "songs",
        "occurrences",
        "ranking_rows",
        "channel_metadata",
        "source_details",
        "source_occurrences",
        "external_songs",
        "external_videos",
        "external_occurrences",
    ):
        result[table] = int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    return result


def read_global_counts(conn: sqlite3.Connection) -> dict[str, int]:
    row = conn.execute(
        """
        WITH all_occurrences AS (
          SELECT video_id, song_key, is_unknown_artist
          FROM occurrences
          WHERE range_id = 'all'
        ),
        grouped AS (
          SELECT
            song_key,
            COUNT(*) AS occurrence_count,
            MAX(is_unknown_artist) AS has_unknown_artist
          FROM all_occurrences
          GROUP BY song_key
        )
        SELECT
          (SELECT COUNT(DISTINCT video_id) FROM all_occurrences) AS videos,
          (SELECT COUNT(*) FROM grouped) AS songs,
          (SELECT COUNT(*) FROM all_occurrences) AS occurrences,
          (SELECT COUNT(*) FROM all_occurrences WHERE is_unknown_artist = 1) AS unknown_artist_occurrences,
          (SELECT COUNT(*) FROM grouped WHERE has_unknown_artist = 1) AS unknown_artist_songs,
          (SELECT COUNT(*) FROM grouped WHERE occurrence_count = 1) AS singleton_songs,
          (SELECT COUNT(*) FROM grouped WHERE occurrence_count = 1 AND has_unknown_artist = 1) AS singleton_unknown_songs
        """
    ).fetchone()
    return {key: int(row[key] or 0) for key in row.keys()}


def read_yoshika(conn: sqlite3.Connection) -> dict[str, Any] | None:
    rows = conn.execute(
        """
        SELECT rank, count, song_count, video_count, payload_json
        FROM ranking_rows
        WHERE range_id = 'all'
          AND view = 'vtubers'
          AND metric = 'count'
          AND scope_key = 'all'
        ORDER BY rank
        """
    )
    for row in rows:
        payload = json.loads(row["payload_json"])
        channel_id = clean_text(payload.get("channelId"))
        handle = normalize_handle(
            payload.get("channelHandle")
            or payload.get("channelUrl")
            or payload.get("sourceUrl")
        )
        name = clean_text(payload.get("name") or payload.get("channelName"))
        if (
            channel_id != YOSHIKA_CHANNEL_ID
            and handle != YOSHIKA_HANDLE
            and "YOSHIKA" not in name
        ):
            continue
        source_key = clean_text(payload.get("sourceDetailKey"))
        source_counts = {"occurrences": 0, "unknownArtistOccurrences": 0}
        if source_key:
            source_row = conn.execute(
                """
                SELECT
                  COUNT(*) AS occurrences,
                  COALESCE(SUM(is_unknown_artist), 0) AS unknown_artist_occurrences
                FROM source_occurrences
                WHERE source_key = ? AND range_id = 'all'
                """,
                (source_key,),
            ).fetchone()
            source_counts = {
                "occurrences": int(source_row["occurrences"] or 0),
                "unknownArtistOccurrences": int(
                    source_row["unknown_artist_occurrences"] or 0
                ),
            }
        source_audit = read_channel_source_audit(conn, payload)
        return {
            "rank": int(row["rank"]),
            "name": name,
            "channelId": channel_id,
            "handle": handle,
            "sourceDetailKey": source_key,
            "songs": int(row["song_count"]),
            "videos": int(row["video_count"]),
            "occurrences": int(row["count"]),
            "singletonSongs": int(
                (source_audit or {}).get("singletonSongs")
                or payload.get("singletonSongCount")
                or 0
            ),
            "expandedSongs": len(payload.get("songs") or []),
            "source": source_counts,
            "sourceAudit": source_audit,
        }
    return None


def read_requested_pages(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    pages = []
    source_cache: dict[str, dict[str, Any] | None] = {}
    for metric in ("count", "songs"):
        for page in (1, 2):
            offset = (page - 1) * 20
            rows = conn.execute(
                """
                SELECT rank, payload_json
                FROM ranking_rows
                WHERE range_id = 'all'
                  AND view = 'vtubers'
                  AND metric = ?
                  AND scope_key = 'all'
                ORDER BY rank
                LIMIT 20 OFFSET ?
                """,
                (metric, offset),
            ).fetchall()
            channels = []
            for row in rows:
                payload = json.loads(row["payload_json"])
                source_key = clean_text(payload.get("sourceDetailKey"))
                if source_key not in source_cache:
                    source_cache[source_key] = (
                        read_channel_source_audit(conn, payload)
                        if source_key
                        else None
                    )
                source_audit = source_cache[source_key]
                summary_songs = payload.get("songs") or []
                channels.append(
                    {
                        "rank": int(row["rank"]),
                        "key": clean_text(payload.get("key")),
                        "name": clean_text(
                            payload.get("name") or payload.get("channelName")
                        ),
                        "channelId": clean_text(payload.get("channelId")),
                        "handle": normalize_handle(
                            payload.get("channelHandle")
                            or payload.get("channelUrl")
                            or payload.get("sourceUrl")
                        ),
                        "songs": int(payload.get("songCount") or 0),
                        "videos": int(payload.get("videoCount") or 0),
                        "occurrences": int(payload.get("count") or 0),
                        "singletonSongs": int(
                            (source_audit or {}).get("singletonSongs")
                            or payload.get("singletonSongCount")
                            or 0
                        ),
                        "sourceDetailKey": source_key,
                        "summaryExpandedSongs": len(summary_songs),
                        "summaryCountMismatch": int(
                            payload.get("songCount") or 0
                        )
                        != len(summary_songs),
                        "sourceAudit": source_audit,
                    }
                )
            if len(channels) != 20:
                raise RuntimeError(
                    f"runtime DB {metric} page {page} expected 20 channels, "
                    f"found {len(channels)}"
                )
            pages.append(
                {
                    "metric": metric,
                    "page": page,
                    "channelCount": len(channels),
                    "summaryExpandedSongCount": sum(
                        row["summaryExpandedSongs"] for row in channels
                    ),
                    "sourceExpandedSongCount": sum(
                        int((row["sourceAudit"] or {}).get("songGroups") or 0)
                        for row in channels
                    ),
                    "summaryCountMismatchCount": sum(
                        1 for row in channels if row["summaryCountMismatch"]
                    ),
                    "channels": channels,
                }
            )
    return pages


def read_channel_source_audit(
    conn: sqlite3.Connection, payload: dict[str, Any]
) -> dict[str, Any] | None:
    source_key = clean_text(payload.get("sourceDetailKey"))
    if not source_key:
        return None
    rows = conn.execute(
        """
        SELECT video_id, title, is_unknown_artist, payload_json
        FROM source_occurrences
        WHERE source_key = ? AND range_id = 'all'
        ORDER BY position
        """,
        (source_key,),
    ).fetchall()
    groups: dict[str, dict[str, Any]] = {}
    unknown_occurrences = 0
    for row in rows:
        occurrence = json.loads(row["payload_json"])
        song = occurrence.get("song") or occurrence
        item = occurrence.get("item") or occurrence
        title = clean_text(
            song.get("canonicalTitle")
            or song.get("title")
            or song.get("displayTitle")
            or row["title"]
        )
        artist = clean_text(
            song.get("canonicalArtist")
            or song.get("artist")
            or song.get("displayArtist")
        )
        unknown = bool(row["is_unknown_artist"]) or is_unknown_artist(artist)
        if unknown:
            artist = "未記載"
            unknown_occurrences += 1
        key = f"{normalize_key(title)}\0{normalize_key(artist)}"
        if key not in groups:
            groups[key] = {
                "title": title,
                "artist": artist,
                "occurrences": 0,
                "_videos": set(),
                "unknownArtist": unknown,
                "numericOnly": bool(re.fullmatch(r"\d{3,}", title)),
                "conversationOrTransition": is_conversation_title(title)
                and unknown,
            }
        group = groups[key]
        group["occurrences"] += 1
        video_id = clean_text(
            occurrence.get("videoId")
            or item.get("videoId")
            or row["video_id"]
        )
        if video_id:
            group["_videos"].add(video_id)
    songs = []
    for group in groups.values():
        songs.append(
            {
                key: value
                for key, value in {
                    **group,
                    "videoCount": len(group["_videos"]),
                }.items()
                if key != "_videos"
            }
        )
    songs.sort(
        key=lambda song: (
            -int(song["occurrences"]),
            normalize_key(song["title"]),
            normalize_key(song["artist"]),
        )
    )
    title_groups: dict[str, dict[str, Any]] = {}
    for song in songs:
        title_group = title_groups.setdefault(
            normalize_key(song["title"]),
            {
                "title": song["title"],
                "knownArtists": {},
                "unknownOccurrences": 0,
            },
        )
        if song["unknownArtist"]:
            title_group["unknownOccurrences"] += int(song["occurrences"])
        else:
            artist = clean_text(song["artist"])
            title_group["knownArtists"][artist] = (
                int(title_group["knownArtists"].get(artist) or 0)
                + int(song["occurrences"])
            )
    same_title_artist_conflicts = []
    unknown_fill_candidates = []
    for title_group in title_groups.values():
        known_artists = [
            {"artist": artist, "occurrences": count}
            for artist, count in sorted(
                title_group["knownArtists"].items(),
                key=lambda item: (-item[1], normalize_key(item[0])),
            )
        ]
        if len(known_artists) > 1:
            same_title_artist_conflicts.append(
                {
                    "title": title_group["title"],
                    "knownArtists": known_artists,
                    "unknownOccurrences": title_group["unknownOccurrences"],
                }
            )
        if (
            title_group["unknownOccurrences"] > 0
            and len(known_artists) == 1
            and known_artists[0]["occurrences"] >= 3
        ):
            unknown_fill_candidates.append(
                {
                    "title": title_group["title"],
                    "knownArtist": known_artists[0],
                    "unknownOccurrences": title_group["unknownOccurrences"],
                }
            )
    same_title_artist_conflicts.sort(
        key=lambda item: (
            -int(item["unknownOccurrences"]),
            normalize_key(item["title"]),
        )
    )
    unknown_fill_candidates.sort(
        key=lambda item: (
            -int(item["unknownOccurrences"]),
            -int(item["knownArtist"]["occurrences"]),
            normalize_key(item["title"]),
        )
    )
    return {
        "sourceDetailKey": source_key,
        "occurrences": len(rows),
        "songGroups": len(songs),
        "unknownArtistOccurrences": unknown_occurrences,
        "unknownArtistSongs": sum(1 for song in songs if song["unknownArtist"]),
        "singletonSongs": sum(
            1 for song in songs if int(song["occurrences"]) == 1
        ),
        "singletonUnknownSongs": sum(
            1
            for song in songs
            if int(song["occurrences"]) == 1 and song["unknownArtist"]
        ),
        "numericOnlySongs": sum(1 for song in songs if song["numericOnly"]),
        "conversationOrTransitionSongs": sum(
            1 for song in songs if song["conversationOrTransition"]
        ),
        "sameTitleArtistConflictCount": len(same_title_artist_conflicts),
        "sameTitleArtistConflicts": same_title_artist_conflicts,
        "unknownFillCandidateCount": len(unknown_fill_candidates),
        "unknownFillCandidates": unknown_fill_candidates,
        "songs": songs,
    }


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        while True:
            block = handle.read(8 * 1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def clean_text(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def normalize_handle(value: Any) -> str:
    text = clean_text(value)
    if "youtube.com/" in text:
        text = text.split("youtube.com/", 1)[1]
    text = text.split("?", 1)[0].split("#", 1)[0].split("/", 1)[0]
    return text.lower() if text.startswith("@") else ""


def normalize_key(value: Any) -> str:
    return "".join(
        unicodedata.normalize("NFKC", clean_text(value)).casefold().split()
    )


def is_unknown_artist(value: Any) -> bool:
    return normalize_key(value) in {
        "",
        "unknown",
        "n/a",
        "na",
        "none",
        "null",
        "未記載",
        "未记载",
        "不明",
        "なし",
        "无",
        "待補歌手",
        "待补歌手",
        "-",
    }


def is_conversation_title(value: Any) -> bool:
    return bool(
        re.search(
            r"(?:雑談|トーク|休憩|戻り|開始|終了|閉会|挨拶|"
            r"お知らせ|告知|自己紹介|コメント|アンケート|"
            r"リアクション|突破)",
            clean_text(value),
        )
    )


def write_json_atomic(file_path: Path, value: Any) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = file_path.with_name(f"{file_path.name}.tmp")
    temp_path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temp_path.replace(file_path)


if __name__ == "__main__":
    raise SystemExit(main())
