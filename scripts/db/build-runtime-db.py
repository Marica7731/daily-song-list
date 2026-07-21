#!/usr/bin/env python3
"""Build a SQLite runtime database from the static song-list payloads."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import unicodedata


SCHEMA_VERSION = 1
ROOT = Path(__file__).resolve().parents[2]
CANONICAL_RANGES = ("7d", "all")
LEGACY_RANGE_ALIASES = {"72h": "7d", "1m": "all"}
LEGACY_RANGE_IDS = {"7d": ("72h",), "all": ("1m",)}
UNKNOWN_ARTISTS = {
    "unknown",
    "n/a",
    "na",
    "none",
    "null",
    "未記載",
    "未记载",
    "不明",
    "无",
    "なし",
    "待补歌手",
    "待補歌手",
    "待补",
    "待補",
    "-",
}


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def log_phase(phase: str, **fields: object) -> None:
    details = " ".join(f"{key}={value}" for key, value in fields.items())
    suffix = f" {details}" if details else ""
    print(f"CODEX_RUNTIME_DB_BUILD_PHASE phase={phase}{suffix}", flush=True)


def main() -> int:
    configure_stdio()
    args = parse_args()
    output_path = args.output.resolve()
    temp_path = output_path.with_name(f"{output_path.name}.tmp")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if temp_path.exists():
        temp_path.unlink()

    try:
        log_phase("read_latest_start", input=args.input)
        latest = hydrate_payload_channel_metadata(
            read_json(args.input),
            (args.youtube_channel_discovery_dir / "channel-metadata.json").resolve(),
        )
        log_phase("read_latest_ok", inputBytes=args.input.stat().st_size)
        log_phase("sqlite_open_start", temp=temp_path)
        conn = sqlite3.connect(temp_path)
        conn.execute("PRAGMA journal_mode=OFF")
        conn.execute("PRAGMA synchronous=OFF")
        conn.execute("PRAGMA temp_store=MEMORY")
        log_phase("schema_start")
        fts_enabled = create_schema(conn)
        log_phase("schema_ok", fts="enabled" if fts_enabled else "disabled")
        write_meta(conn, "schema_version", str(SCHEMA_VERSION))
        write_meta(conn, "builder", "scripts/db/build-runtime-db.py")
        write_meta(conn, "built_at", utc_now())
        write_meta(conn, "source_latest_json", str(args.input))
        write_meta(conn, "source_latest_sha256", sha256_file(args.input))
        source_commit_sha = git_commit_sha()
        if source_commit_sha:
            write_meta(conn, "source_commit_sha", source_commit_sha)
        if latest.get("generatedAt"):
            write_meta(conn, "latest_generated_at", str(latest.get("generatedAt")))
        if latest.get("capturedAt"):
            write_meta(conn, "latest_captured_at", str(latest.get("capturedAt")))

        if args.ranking_source == "js":
            log_phase("runtime_rankings_start", source="js")
            latest_counts = ingest_js_runtime_export(conn, args, output_path, fts_enabled)
            write_meta(conn, "runtime_ranking_source", "runtime-js")
        else:
            log_phase("runtime_rankings_start", source="python")
            latest_counts = ingest_latest_payload(conn, latest, args.limit_per_range, fts_enabled)
            write_meta(conn, "runtime_ranking_source", "python")
        log_phase(
            "runtime_rankings_ok",
            videos=latest_counts["videos"],
            songs=latest_counts["songs"],
            occurrences=latest_counts["occurrences"],
            rankingRows=latest_counts["ranking_rows"],
            sourceOccurrences=latest_counts.get("source_occurrences", 0),
        )
        if args.vsinger_dir and not args.no_vsinger:
            log_phase("vsinger_start", dir=args.vsinger_dir)
        vsinger_counts = (
            ingest_vsinger_backfill(conn, args.vsinger_dir, args.limit_external_shards, fts_enabled)
            if args.vsinger_dir and not args.no_vsinger
            else empty_external_counts()
        )
        log_phase(
            "vsinger_ok",
            songs=vsinger_counts["songs"],
            videos=vsinger_counts["videos"],
            occurrences=vsinger_counts["occurrences"],
            rankingRows=vsinger_counts["ranking_rows"],
        )
        for key, value in latest_counts.items():
            write_meta(conn, f"latest_{key}", str(value))
        for key, value in vsinger_counts.items():
            write_meta(conn, f"vsinger_{key}", str(value))

        log_phase("commit_start")
        conn.commit()
        log_phase("commit_ok", tempBytes=temp_path.stat().st_size if temp_path.exists() else 0)
        log_phase("vacuum_start")
        conn.execute("VACUUM")
        log_phase("vacuum_ok", tempBytes=temp_path.stat().st_size if temp_path.exists() else 0)
        conn.close()
        log_phase("replace_start", output=output_path)
        os.replace(temp_path, output_path)
        log_phase("replace_ok", outputBytes=output_path.stat().st_size)
    except Exception as exc:  # pragma: no cover - exercised by CLI failure paths
        try:
            conn.close()  # type: ignore[name-defined]
        except Exception:
            pass
        if temp_path.exists():
            temp_path.unlink()
        print(f"CODEX_RUNTIME_DB_BUILD_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    print(
        "CODEX_RUNTIME_DB_BUILD_OK "
        f"db={output_path} "
        f"videos={latest_counts['videos']} "
        f"songs={latest_counts['songs']} "
        f"occurrences={latest_counts['occurrences']} "
        f"rankingRows={latest_counts['ranking_rows']} "
        f"sourceOccurrences={latest_counts.get('source_occurrences', 0)} "
        f"vsingerSongs={vsinger_counts['songs']} "
        f"vsingerVideos={vsinger_counts['videos']} "
        f"vsingerOccurrences={vsinger_counts['occurrences']} "
        f"vsingerRankingRows={vsinger_counts['ranking_rows']} "
        f"fts={'enabled' if latest_counts['fts_enabled'] else 'disabled'}"
    )
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path("data/latest.json"), help="runtime latest.json input")
    parser.add_argument(
        "--vsinger-dir",
        type=Path,
        default=Path("data/external/vsinger-http/backfill"),
        help="VSinger Moment backfill directory with manifest.json",
    )
    parser.add_argument(
        "--youtube-channel-discovery-dir",
        type=Path,
        default=Path("data/external/youtube-channel-discovery"),
        help="YouTube channel discovery accepted increment directory",
    )
    parser.add_argument("--output", type=Path, default=Path("artifacts/runtime/song-rank.sqlite"))
    parser.add_argument(
        "--limit-per-range",
        type=int,
        default=0,
        help="test helper: ingest only the first N videos per canonical range",
    )
    parser.add_argument(
        "--limit-external-shards",
        type=int,
        default=0,
        help="test helper: ingest only the first N shards of each VSinger kind",
    )
    parser.add_argument("--no-vsinger", action="store_true", help="skip VSinger external backfill tables")
    parser.add_argument(
        "--no-youtube-channel-discovery",
        action="store_true",
        help="skip YouTube channel discovery accepted increments in JS ranking export",
    )
    parser.add_argument(
        "--require-youtube-channel-discovery",
        action="store_true",
        help="fail if YouTube channel discovery accepted increments are missing",
    )
    parser.add_argument(
        "--ranking-source",
        choices=("js", "python"),
        default="js",
        help="ranking row source: js reuses frontend/runtime merge rules; python keeps the local fallback",
    )
    parser.add_argument("--node-bin", default="node", help="Node.js executable used by --ranking-source js")
    parser.add_argument(
        "--runtime-ranking-export",
        type=Path,
        default=Path("scripts/db/export-runtime-rankings.js"),
        help="Node exporter used by --ranking-source js",
    )
    parser.add_argument(
        "--allow-partial-vsinger",
        action="store_true",
        help="allow incomplete VSinger bundle only for fixtures or diagnostics",
    )
    return parser.parse_args()


def create_schema(conn: sqlite3.Connection) -> bool:
    conn.executescript(
        """
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE videos (
          video_id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          channel_name TEXT NOT NULL DEFAULT '',
          channel_id TEXT NOT NULL DEFAULT '',
          channel_handle TEXT NOT NULL DEFAULT '',
          channel_url TEXT NOT NULL DEFAULT '',
          keyword TEXT NOT NULL DEFAULT '',
          published_timestamp INTEGER,
          published_text TEXT NOT NULL DEFAULT '',
          duration_text TEXT NOT NULL DEFAULT '',
          thumbnail_url TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL
        );

        CREATE TABLE songs (
          song_key TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          artist TEXT NOT NULL DEFAULT '',
          is_niche INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT NOT NULL
        );

        CREATE TABLE occurrences (
          occurrence_id TEXT PRIMARY KEY,
          range_id TEXT NOT NULL,
          video_id TEXT NOT NULL,
          song_key TEXT NOT NULL,
          seconds INTEGER,
          source_system TEXT NOT NULL,
          source_id TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          artist TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL
        );
        CREATE INDEX idx_occurrences_range_song ON occurrences(range_id, song_key);
        CREATE INDEX idx_occurrences_range_video ON occurrences(range_id, video_id);

        CREATE TABLE ranking_rows (
          row_id TEXT PRIMARY KEY,
          range_id TEXT NOT NULL,
          view TEXT NOT NULL,
          metric TEXT NOT NULL DEFAULT 'count',
          scope_key TEXT NOT NULL DEFAULT 'all',
          rank INTEGER NOT NULL,
          detail_key TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          artist TEXT NOT NULL DEFAULT '',
          name TEXT NOT NULL DEFAULT '',
          count INTEGER NOT NULL DEFAULT 0,
          song_count INTEGER NOT NULL DEFAULT 0,
          video_count INTEGER NOT NULL DEFAULT 0,
          timestamp_count INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT NOT NULL,
          search_text TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX idx_ranking_lookup ON ranking_rows(range_id, view, metric, scope_key, rank);
        CREATE INDEX idx_ranking_detail ON ranking_rows(range_id, view, detail_key);

        CREATE TABLE channel_metadata (
          channel_key TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL DEFAULT '',
          handle TEXT NOT NULL DEFAULT '',
          display_name TEXT NOT NULL DEFAULT '',
          avatar_url TEXT NOT NULL DEFAULT '',
          thumbnail_url TEXT NOT NULL DEFAULT '',
          source_url TEXT NOT NULL DEFAULT '',
          channel_url TEXT NOT NULL DEFAULT '',
          known_source_type TEXT NOT NULL DEFAULT '',
          is_collected INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX idx_channel_metadata_handle ON channel_metadata(handle);
        CREATE INDEX idx_channel_metadata_channel_id ON channel_metadata(channel_id);

        CREATE TABLE source_details (
          source_key TEXT PRIMARY KEY,
          range_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_key TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX idx_source_details_entity ON source_details(range_id, entity_type, entity_key);

        CREATE TABLE source_occurrences (
          source_key TEXT NOT NULL,
          range_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          video_id TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          channel_name TEXT NOT NULL DEFAULT '',
          published_timestamp INTEGER,
          seconds INTEGER,
          search_text TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL,
          PRIMARY KEY (source_key, position)
        );
        CREATE INDEX idx_source_occurrences_lookup ON source_occurrences(source_key, position);
        CREATE INDEX idx_source_occurrences_range ON source_occurrences(range_id, source_key);

        CREATE TABLE external_songs (
          source_system TEXT NOT NULL,
          external_song_id TEXT NOT NULL,
          canonical_song_id TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          artist TEXT NOT NULL DEFAULT '',
          source_url TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL,
          PRIMARY KEY (source_system, external_song_id)
        );

        CREATE TABLE external_videos (
          source_system TEXT NOT NULL,
          external_video_id TEXT NOT NULL,
          youtube_video_id TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          singer_name TEXT NOT NULL DEFAULT '',
          streamed_at TEXT NOT NULL DEFAULT '',
          source_url TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL,
          PRIMARY KEY (source_system, external_video_id)
        );
        CREATE INDEX idx_external_videos_youtube ON external_videos(youtube_video_id);

        CREATE TABLE external_occurrences (
          source_system TEXT NOT NULL,
          occurrence_id TEXT NOT NULL,
          canonical_song_id TEXT NOT NULL DEFAULT '',
          external_song_id TEXT NOT NULL DEFAULT '',
          external_video_id TEXT NOT NULL DEFAULT '',
          youtube_video_id TEXT NOT NULL DEFAULT '',
          seconds INTEGER,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (source_system, occurrence_id)
        );
        CREATE INDEX idx_external_occurrences_song ON external_occurrences(source_system, external_song_id);
        CREATE INDEX idx_external_occurrences_video ON external_occurrences(source_system, youtube_video_id);
        """
    )
    try:
        conn.execute("CREATE VIRTUAL TABLE ranking_fts USING fts5(row_id UNINDEXED, search_text)")
        return True
    except sqlite3.OperationalError:
        return False


def write_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_commit_sha() -> str:
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return ""
    return completed.stdout.strip()


def ingest_latest_payload(
    conn: sqlite3.Connection,
    payload: dict,
    limit_per_range: int,
    fts_enabled: bool,
    build_rankings: bool = True,
) -> dict[str, int]:
    groups = payload.get("groups") if isinstance(payload.get("groups"), dict) else {}
    all_video_ids: set[str] = set()
    all_song_keys: set[str] = set()
    all_occurrence_ids: set[str] = set()
    ranking_row_count = 0
    source_occurrence_count = 0

    for range_id in CANONICAL_RANGES:
        group = group_for_range(groups, range_id)
        items = group.get("items") if isinstance(group, dict) and isinstance(group.get("items"), list) else []
        if limit_per_range > 0:
            items = items[:limit_per_range]
        write_meta(conn, f"range_{range_id}_item_count", str(len(items)))

        range_state = empty_range_state()
        for item_index, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            video_id = video_key(item)
            all_video_ids.add(video_id)
            upsert_video(conn, video_id, item)
            upsert_channel_metadata(conn, item)

            item_songs = item.get("songs") if isinstance(item.get("songs"), list) else []
            valid_songs = runtime_scoped_songs(item_songs, item)
            record_video(range_state, range_id, video_id, item, valid_songs)
            record_vtuber(range_state, video_id, item, valid_songs)
            source_key = stable_key("source-video", range_id, video_id)
            insert_source_detail(conn, source_key, range_id, "video", video_id, source_payload_for_video(item, valid_songs))

            for song_index, song in enumerate(valid_songs):
                song_key = song_record_key(song)
                all_song_keys.add(song_key)
                upsert_song(conn, song_key, song)
                occurrence_id = stable_key(
                    "occurrence",
                    range_id,
                    video_id,
                    item_index,
                    song_index,
                    song.get("seconds"),
                    song.get("raw"),
                    song.get("title"),
                    song.get("artist"),
                )
                all_occurrence_ids.add(occurrence_id)
                insert_occurrence(conn, occurrence_id, range_id, video_id, song_key, item, song)
                record_song(range_state, range_id, video_id, item, song_key, song)
                record_artist(range_state, range_id, video_id, item, song)

        if build_rankings:
            ranking_rows = build_ranking_rows(range_id, range_state)
            for row in ranking_rows:
                source_detail = row.get("source_detail")
                if source_detail:
                    insert_source_detail(
                        conn,
                        source_detail["source_key"],
                        range_id,
                        source_detail["entity_type"],
                        source_detail["entity_key"],
                        source_detail["payload"],
                    )
                    source_occurrence_count += insert_source_occurrences_for_detail(
                        conn,
                        source_detail["source_key"],
                        range_id,
                        source_detail["payload"],
                    )
                insert_ranking_row(conn, row, fts_enabled)
            ranking_row_count += len(ranking_rows)
            write_meta(conn, f"range_{range_id}_ranking_rows", str(len(ranking_rows)))

    return {
        "videos": len(all_video_ids),
        "songs": len(all_song_keys),
        "occurrences": len(all_occurrence_ids),
        "ranking_rows": ranking_row_count,
        "source_occurrences": source_occurrence_count,
        "fts_enabled": 1 if fts_enabled else 0,
    }


def ingest_js_runtime_export(
    conn: sqlite3.Connection,
    args: argparse.Namespace,
    output_path: Path,
    fts_enabled: bool,
) -> dict[str, int]:
    export_path = output_path.with_name(f"{output_path.stem}.runtime-rankings.jsonl.tmp")
    if export_path.exists():
        export_path.unlink()
    exporter_path = args.runtime_ranking_export
    if not exporter_path.is_absolute():
        exporter_path = ROOT / exporter_path
    command = [
        args.node_bin,
        str(exporter_path),
        "--input",
        str(args.input),
        "--output",
        str(export_path),
    ]
    if args.limit_per_range > 0:
        command.extend(["--limit-per-range", str(args.limit_per_range)])
    if args.no_vsinger:
        command.append("--no-vsinger")
    elif args.vsinger_dir:
        command.extend(["--vsinger-dir", str(args.vsinger_dir)])
        if args.limit_external_shards <= 0:
            command.append("--require-vsinger")
        if args.allow_partial_vsinger:
            command.append("--allow-partial-vsinger")
    if args.no_youtube_channel_discovery:
        command.append("--no-youtube-channel-discovery")
    elif args.youtube_channel_discovery_dir:
        command.extend(["--youtube-channel-discovery-dir", str(args.youtube_channel_discovery_dir)])
        if args.require_youtube_channel_discovery:
            command.append("--require-youtube-channel-discovery")

    log_phase("js_export_start", output=export_path)
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
    )
    export_ok = False
    output_tail: list[str] = []
    assert process.stdout is not None
    for line in process.stdout:
        print(line, end="", flush=True)
        if "CODEX_RUNTIME_RANKINGS_EXPORT_OK" in line:
            export_ok = True
        output_tail.append(line.rstrip("\n"))
        if len(output_tail) > 40:
            output_tail = output_tail[-40:]
    return_code = process.wait()
    log_phase("js_export_done", exit=return_code, outputBytes=export_path.stat().st_size if export_path.exists() else 0)
    if return_code != 0 or not export_ok:
        raise RuntimeError(
            "runtime ranking export failed: "
            f"exit={return_code} tail={os.linesep.join(output_tail)}"
        )

    log_phase("js_import_start", input=export_path)
    counts = import_js_runtime_export(conn, export_path, fts_enabled)
    log_phase(
        "js_import_ok",
        rankingRows=counts["ranking_rows"],
        sourceDetails=counts["source_details"],
        sourceOccurrences=counts["source_occurrences"],
    )
    try:
        export_path.unlink()
    except FileNotFoundError:
        pass
    write_meta(conn, "runtime_ranking_export_stdout_tail", os.linesep.join(output_tail))
    return counts


def import_js_runtime_export(conn: sqlite3.Connection, export_path: Path, fts_enabled: bool) -> dict[str, int]:
    counts = {
        "videos": 0,
        "songs": 0,
        "occurrences": 0,
        "ranking_rows": 0,
        "source_details": 0,
        "source_occurrences": 0,
        "fts_enabled": 1 if fts_enabled else 0,
    }
    video_ids: set[str] = set()
    song_keys: set[str] = set()
    occurrence_ids: set[str] = set()
    with export_path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            record = json.loads(line)
            kind = record.get("kind")
            if kind == "ranking":
                insert_ranking_row(
                    conn,
                    {
                        "row_id": clean_text(record.get("rowId")),
                        "range_id": clean_text(record.get("rangeId")),
                        "view": clean_text(record.get("view")),
                        "metric": clean_text(record.get("metric")) or "count",
                        "scope_key": clean_text(record.get("scopeKey")) or "all",
                        "rank": int(record.get("rank") or 0),
                        "detail_key": clean_text(record.get("detailKey")),
                        "title": clean_text(record.get("title")),
                        "artist": clean_text(record.get("artist")),
                        "name": clean_text(record.get("name")),
                        "count": int(record.get("count") or 0),
                        "song_count": int(record.get("songCount") or 0),
                        "video_count": int(record.get("videoCount") or 0),
                        "timestamp_count": int(record.get("timestampCount") or record.get("count") or 0),
                        "payload": record.get("payload") if isinstance(record.get("payload"), dict) else {},
                        "search_text": clean_text(record.get("searchText")),
                    },
                    fts_enabled,
                )
                counts["ranking_rows"] += 1
            elif kind == "sourceDetail":
                insert_source_detail(
                    conn,
                    clean_text(record.get("sourceKey")),
                    clean_text(record.get("rangeId")),
                    clean_text(record.get("entityType")) or "source",
                    clean_text(record.get("entityKey")),
                    record.get("payload") if isinstance(record.get("payload"), dict) else {},
                )
                counts["source_details"] += 1
            elif kind == "sourceOccurrence":
                insert_source_occurrence(
                    conn,
                    clean_text(record.get("sourceKey")),
                    clean_text(record.get("rangeId")),
                    int(record.get("position") or 0),
                    record.get("payload") if isinstance(record.get("payload"), dict) else {},
                )
                counts["source_occurrences"] += 1
            elif kind == "runtimeVideo":
                item = record.get("item") if isinstance(record.get("item"), dict) else {}
                range_id = clean_text(record.get("rangeId"))
                item_index = int(record.get("itemIndex") or 0)
                video_id = video_key(item)
                if video_id:
                    video_ids.add(video_id)
                upsert_video(conn, video_id, item)
                upsert_channel_metadata(conn, item)
                item_songs = item.get("songs") if isinstance(item.get("songs"), list) else []
                valid_songs = runtime_scoped_songs(item_songs, item)
                for song_index, song in enumerate(valid_songs):
                    song_key = song_record_key(song)
                    song_keys.add(song_key)
                    upsert_song(conn, song_key, song)
                    occurrence_id = stable_key(
                        "occurrence",
                        range_id,
                        video_id,
                        item_index,
                        song_index,
                        song.get("seconds"),
                        song.get("raw"),
                        song.get("title"),
                        song.get("artist"),
                    )
                    occurrence_ids.add(occurrence_id)
                    insert_occurrence(conn, occurrence_id, range_id, video_id, song_key, item, song)
            elif kind in {"meta", "range"}:
                continue
            else:
                raise ValueError(f"unsupported runtime ranking export record at line {line_number}: {kind}")
            if line_number % 100000 == 0:
                log_phase(
                    "js_import_progress",
                    lines=line_number,
                    rankingRows=counts["ranking_rows"],
                    sourceDetails=counts["source_details"],
                    sourceOccurrences=counts["source_occurrences"],
                    videos=len(video_ids),
                    songs=len(song_keys),
                    occurrences=len(occurrence_ids),
                )
    counts["videos"] = len(video_ids)
    counts["songs"] = len(song_keys)
    counts["occurrences"] = len(occurrence_ids)
    return counts


def empty_range_state() -> dict:
    return {"videos": [], "songs": {}, "artists": {}, "vtubers": {}}


def record_video(state: dict, range_id: str, video_id: str, item: dict, songs: list[dict]) -> None:
    published_timestamp = int_or_none(item.get("publishedTimestamp"))
    payload = {
        "type": "video",
        "key": video_id,
        "videoId": video_id,
        "title": clean_text(item.get("title")),
        "channelName": clean_text(item.get("channelName")),
        "channelId": clean_text(item.get("channelId")),
        "channelHandle": clean_text(item.get("channelHandle")),
        "channelUrl": clean_text(item.get("channelUrl") or item.get("authorUrl") or item.get("ownerUrl")),
        "avatarUrl": clean_text(item.get("avatarUrl") or item.get("channelAvatarUrl")),
        "sourceUrl": clean_text(item.get("sourceUrl") or item.get("channelUrl") or item.get("authorUrl") or item.get("ownerUrl")),
        "knownSourceType": clean_text(item.get("knownSourceType")) or known_source_type(item),
        "isCollected": is_collected_source(item),
        "keyword": clean_text(item.get("keyword")),
        "publishedTimestamp": published_timestamp,
        "publishedAt": timestamp_to_iso(published_timestamp),
        "timeMissingReason": "" if published_timestamp else time_missing_reason(item),
        "publishedText": clean_text(item.get("publishedText")),
        "durationText": clean_text(item.get("durationText")),
        "thumbnailUrl": clean_text(item.get("thumbnailUrl") or item.get("thumbnail")),
        "songCount": len(songs),
        "songs": [compact_song(song) for song in songs],
        "sourceDetailKey": stable_key("source-video", range_id, video_id),
    }
    state["videos"].append(
        {
            "key": video_id,
            "title": payload["title"],
            "artist": "",
            "name": payload["channelName"],
            "count": len(songs),
            "song_count": len({normalize_key(song.get("title")) for song in songs if clean_text(song.get("title"))}),
            "video_count": 1,
            "timestamp_count": len(songs),
            "payload": payload,
            "search_text": search_text(
                video_id,
                payload["title"],
                payload["channelName"],
                payload["channelId"],
                payload["channelHandle"],
                payload["channelUrl"],
                payload["keyword"],
                *[part for song in songs for part in (song.get("title"), song.get("artist"))],
            ),
            "sort_timestamp": payload["publishedTimestamp"] or 0,
        }
    )


def record_song(state: dict, range_id: str, video_id: str, item: dict, song_key: str, song: dict) -> None:
    if is_likely_runtime_non_song_entry(song, item):
        return
    title = clean_text(song.get("title"))
    artist = clean_text(song.get("artist"))
    if song_key not in state["songs"]:
        state["songs"][song_key] = {
            "key": song_key,
            "title": title,
            "artist": artist,
            "count": 0,
            "videos": set(),
            "channels": {},
            "occurrences": [],
            "niche_count": 0,
        }
    record = state["songs"][song_key]
    record["count"] += 1
    record["videos"].add(video_id)
    record["niche_count"] += 1 if song.get("isNiche") is True else 0
    increment_count(record["channels"], clean_text(item.get("channelName")))
    append_preview_occurrence(record["occurrences"], item, song, video_id)


def record_artist(state: dict, range_id: str, video_id: str, item: dict, song: dict) -> None:
    artist = clean_text(song.get("artist"))
    if is_unknown_artist(artist):
        return
    artist_key = normalize_key(artist)
    if not artist_key:
        return
    if artist_key not in state["artists"]:
        state["artists"][artist_key] = {
            "key": artist_key,
            "name": artist,
            "count": 0,
            "videos": set(),
            "songs": {},
            "channels": {},
            "occurrences": [],
        }
    record = state["artists"][artist_key]
    record["count"] += 1
    record["videos"].add(video_id)
    increment_count(record["songs"], clean_text(song.get("title")))
    increment_count(record["channels"], clean_text(item.get("channelName")))
    append_preview_occurrence(record["occurrences"], item, song, video_id)


def record_vtuber(state: dict, video_id: str, item: dict, songs: list[dict]) -> None:
    channel_key = channel_record_key(item)
    if not channel_key:
        return
    if channel_key not in state["vtubers"]:
        state["vtubers"][channel_key] = {
            "key": channel_key,
            "name": clean_text(item.get("channelName") or item.get("channelHandle") or item.get("channelId") or "未知频道"),
            "channel_name": clean_text(item.get("channelName")),
            "channel_id": clean_text(item.get("channelId")),
            "channel_handle": clean_text(item.get("channelHandle")),
            "channel_url": clean_text(item.get("channelUrl") or item.get("authorUrl") or item.get("ownerUrl")),
            "avatar_url": clean_text(item.get("avatarUrl") or item.get("channelAvatarUrl")),
            "thumbnail_url": vtuber_thumbnail_candidate(item),
            "source_url": clean_text(item.get("sourceUrl") or item.get("channelUrl") or item.get("authorUrl") or item.get("ownerUrl")),
            "known_source_type": clean_text(item.get("knownSourceType")) or known_source_type(item),
            "is_collected": is_collected_source(item),
            "count": 0,
            "videos": set(),
            "songs": {},
            "occurrences": [],
        }
    record = state["vtubers"][channel_key]
    if video_id:
        record["videos"].add(video_id)
    merge_channel_record_identity(record, item)
    for song in songs:
        record["count"] += 1
        increment_vtuber_song_count(record["songs"], song)
        append_preview_occurrence(record["occurrences"], item, song, video_id)


def build_ranking_rows(range_id: str, state: dict) -> list[dict]:
    rows: list[dict] = []
    rows.extend(rank_rows_for_videos(range_id, state["videos"]))
    rows.extend(rank_rows_for_songs(range_id, state["songs"].values(), "songs"))
    rows.extend(rank_rows_for_songs(range_id, state["songs"].values(), "songs", metric="videos"))
    rows.extend(index_rows_for_songs(range_id, state["songs"].values()))
    rows.extend(rank_rows_for_artists(range_id, state["artists"].values()))
    rows.extend(rank_rows_for_artists(range_id, state["artists"].values(), metric="videos"))
    rows.extend(rank_rows_for_vtubers(range_id, state["vtubers"].values()))
    rows.extend(rank_rows_for_vtubers(range_id, state["vtubers"].values(), metric="songs"))
    rows.extend(rank_rows_for_vtubers(range_id, state["vtubers"].values(), metric="videos"))
    return rows


def merge_channel_record_identity(record: dict, item: dict) -> None:
    channel_name = clean_text(item.get("channelName"))
    channel_id = clean_text(item.get("channelId"))
    channel_handle = clean_text(item.get("channelHandle"))
    channel_url = clean_text(item.get("channelUrl") or item.get("authorUrl") or item.get("ownerUrl"))
    avatar_url = clean_text(item.get("avatarUrl") or item.get("channelAvatarUrl"))
    thumbnail_url = vtuber_thumbnail_candidate(item)
    source_url = clean_text(item.get("sourceUrl") or channel_url)
    source_type = clean_text(item.get("knownSourceType")) or known_source_type(item)
    if channel_name:
        record["channel_name"] = record["channel_name"] or channel_name
        if not record["name"] or record["name"] == "未知频道":
            record["name"] = channel_name
    if channel_id:
        record["channel_id"] = record["channel_id"] or channel_id
    if channel_handle:
        record["channel_handle"] = record["channel_handle"] or channel_handle
    if channel_url:
        record["channel_url"] = record["channel_url"] or channel_url
    if avatar_url:
        record["avatar_url"] = record["avatar_url"] or avatar_url
    if thumbnail_url and should_use_vtuber_thumbnail(record, item):
        record["thumbnail_url"] = thumbnail_url
    if source_url:
        record["source_url"] = record["source_url"] or source_url
    if should_replace_known_source_type(record.get("known_source_type"), source_type):
        record["known_source_type"] = source_type
    record["is_collected"] = bool(record.get("is_collected")) or is_collected_source(item)


def vtuber_thumbnail_candidate(item: dict) -> str:
    return clean_text(item.get("thumbnailUrl") or item.get("videoThumbnail") or item.get("videoThumbnailUrl") or item.get("thumbnail")) or thumbnail_url_for_video(item)


def should_use_vtuber_thumbnail(record: dict, item: dict) -> bool:
    if not record.get("thumbnail_url"):
        record["thumbnail_published_timestamp"] = int_or_none(item.get("publishedTimestamp")) or 0
        return True
    incoming_timestamp = int_or_none(item.get("publishedTimestamp")) or 0
    current_timestamp = int(record.get("thumbnail_published_timestamp") or 0)
    if incoming_timestamp >= current_timestamp:
        record["thumbnail_published_timestamp"] = incoming_timestamp
        return True
    return False


def rank_rows_for_videos(range_id: str, records: list[dict]) -> list[dict]:
    sorted_records = sorted(records, key=lambda row: (-row["count"], -row["sort_timestamp"], row["title"], row["key"]))
    result = []
    for rank, record in enumerate(sorted_records, start=1):
        result.append(row_payload(range_id, "videos", rank, record))
    return result


def rank_rows_for_songs(range_id: str, records, view: str, metric: str = "count") -> list[dict]:
    sorted_records = sorted(records, key=lambda row: (-rank_metric_value(row, metric), row["title"], row["artist"], row["key"]))
    result = []
    for rank, record in enumerate(sorted_records, start=1):
        payload = {
            "type": "song",
            "key": record["key"],
            "title": record["title"],
            "displayArtist": record["artist"],
            "count": record["count"],
            "videoCount": len(record["videos"]),
            "timestampCount": record["count"],
            "channels": count_map_to_list(record["channels"]),
            "occurrences": record["occurrences"],
            "sourceDetailKey": stable_key("source-song", range_id, record["key"]),
        }
        source_detail = {**payload, "occurrencePreviewLimited": len(record["occurrences"]) >= 20}
        record_for_row = {
            "key": record["key"],
            "title": record["title"],
            "artist": record["artist"],
            "name": "",
            "count": record["count"],
            "video_count": len(record["videos"]),
            "timestamp_count": record["count"],
            "payload": payload,
            "search_text": search_text(
                record["title"],
                record["artist"],
                *record["channels"].keys(),
                *occurrence_preview_search_parts(record["occurrences"]),
            ),
            "source_detail": {
                "source_key": payload["sourceDetailKey"],
                "entity_type": "song",
                "entity_key": record["key"],
                "payload": source_detail,
            },
        }
        result.append(row_payload(range_id, view, rank, record_for_row, metric=metric))
        record["source_detail"] = source_detail
    return result


def index_rows_for_songs(range_id: str, records) -> list[dict]:
    sorted_records = sorted(records, key=lambda row: (normalize_key(row["title"]), normalize_key(row["artist"]), row["key"]))
    result = []
    for rank, record in enumerate(sorted_records, start=1):
        payload = {
            "type": "song",
            "key": record["key"],
            "title": record["title"],
            "displayArtist": record["artist"],
            "count": record["count"],
            "videoCount": len(record["videos"]),
            "timestampCount": record["count"],
            "channels": count_map_to_list(record["channels"]),
            "occurrences": record["occurrences"],
            "sourceDetailKey": stable_key("source-song", range_id, record["key"]),
        }
        row = {
            "key": record["key"],
            "title": record["title"],
            "artist": record["artist"],
            "name": "",
            "count": record["count"],
            "video_count": len(record["videos"]),
            "timestamp_count": record["count"],
            "payload": payload,
            "search_text": search_text(
                record["title"],
                record["artist"],
                *record["channels"].keys(),
                *occurrence_preview_search_parts(record["occurrences"]),
            ),
            "source_detail": {
                "source_key": payload["sourceDetailKey"],
                "entity_type": "song",
                "entity_key": record["key"],
                "payload": {**payload, "occurrencePreviewLimited": len(record["occurrences"]) >= 20},
            },
        }
        result.append(row_payload(range_id, "songIndex", rank, row))
    return result


def rank_rows_for_artists(range_id: str, records, metric: str = "count") -> list[dict]:
    sorted_records = sorted(records, key=lambda row: (-rank_metric_value(row, metric), row["name"], row["key"]))
    result = []
    for rank, record in enumerate(sorted_records, start=1):
        payload = {
            "type": "artist",
            "key": record["key"],
            "name": record["name"],
            "count": record["count"],
            "videoCount": len(record["videos"]),
            "timestampCount": record["count"],
            "songs": count_map_to_list(record["songs"]),
            "channels": count_map_to_list(record["channels"]),
            "occurrences": record["occurrences"],
            "sourceDetailKey": stable_key("source-artist", range_id, record["key"]),
        }
        row = {
            "key": record["key"],
            "title": "",
            "artist": "",
            "name": record["name"],
            "count": record["count"],
            "video_count": len(record["videos"]),
            "timestamp_count": record["count"],
            "payload": payload,
            "search_text": search_text(record["name"]),
            "source_detail": {
                "source_key": payload["sourceDetailKey"],
                "entity_type": "artist",
                "entity_key": record["key"],
                "payload": {**payload, "occurrencePreviewLimited": len(record["occurrences"]) >= 20},
            },
        }
        result.append(row_payload(range_id, "artists", rank, row, metric=metric))
    return result


def rank_rows_for_vtubers(range_id: str, records, metric: str = "count") -> list[dict]:
    validate_vtuber_display_images(records, range_id)
    sorted_records = sorted(records, key=lambda row: (-rank_metric_value(row, metric), normalize_key(row["name"]), row["key"]))
    result = []
    for rank, record in enumerate(sorted_records, start=1):
        payload = {
            "type": "vtuber",
            "key": record["key"],
            "name": record["name"],
            "channelName": record["channel_name"],
            "channelId": record["channel_id"],
            "channelHandle": record["channel_handle"],
            "channelUrl": record["channel_url"],
            "avatarUrl": record.get("avatar_url", ""),
            "thumbnailUrl": record.get("thumbnail_url", ""),
            "videoThumbnailUrl": record.get("thumbnail_url", ""),
            "sourceUrl": record.get("source_url", "") or record["channel_url"],
            "knownSourceType": record.get("known_source_type", ""),
            "isCollected": bool(record.get("is_collected")),
            "count": record["count"],
            "songCount": len(record["songs"]),
            "videoCount": len(record["videos"]),
            "timestampCount": record["count"],
            "songs": count_map_to_list(record["songs"]),
            "occurrences": record["occurrences"],
        }
        row = {
            "key": record["key"],
            "title": "",
            "artist": "",
            "name": record["name"],
            "count": record["count"],
            "song_count": len(record["songs"]),
            "video_count": len(record["videos"]),
            "timestamp_count": record["count"],
            "payload": payload,
            "search_text": search_text(record["name"], record["channel_name"], record["channel_id"], record["channel_handle"], record["channel_url"]),
        }
        result.append(row_payload(range_id, "vtubers", rank, row, metric=metric))
    return result


def validate_vtuber_display_images(records, range_id: str) -> None:
    missing = [record for record in records if not clean_text(record.get("avatar_url")) and not clean_text(record.get("thumbnail_url"))]
    if not missing:
        return
    sample = ", ".join(
        " ".join(filter(None, [record.get("channel_handle", ""), record.get("channel_id", ""), record.get("name", "")])) or record.get("key", "")
        for record in missing[:10]
    )
    raise ValueError(f"VTuber display image missing: range={range_id} count={len(missing)} sample={sample}")


def rank_metric_value(record: dict, metric: str) -> int:
    if metric == "songs":
        songs = record.get("songs")
        return len(songs) if hasattr(songs, "__len__") else int(record.get("song_count") or 0)
    if metric == "videos":
        videos = record.get("videos")
        return len(videos) if hasattr(videos, "__len__") else int(record.get("video_count") or 0)
    return int(record.get("count") or 0)


def row_payload(range_id: str, view: str, rank: int, record: dict, metric: str = "count") -> dict:
    row = {
        "row_id": stable_key("ranking-row", range_id, view, metric, "all", record["key"]),
        "range_id": range_id,
        "view": view,
        "metric": metric,
        "scope_key": "all",
        "rank": rank,
        "detail_key": record["key"],
        "title": record.get("title", ""),
        "artist": record.get("artist", ""),
        "name": record.get("name", ""),
        "count": int(record.get("count") or 0),
        "song_count": int(record.get("song_count") or 0),
        "video_count": int(record.get("video_count") or 0),
        "timestamp_count": int(record.get("timestamp_count") or 0),
        "payload": record.get("payload", {}),
        "search_text": record.get("search_text", ""),
    }
    if record.get("source_detail"):
        row["source_detail"] = record["source_detail"]
    return row


def insert_ranking_row(conn: sqlite3.Connection, row: dict, fts_enabled: bool) -> None:
    conn.execute(
        """
        INSERT INTO ranking_rows(
          row_id, range_id, view, metric, scope_key, rank, detail_key, title, artist, name,
          count, song_count, video_count, timestamp_count, payload_json, search_text
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row["row_id"],
            row["range_id"],
            row["view"],
            row["metric"],
            row["scope_key"],
            row["rank"],
            row["detail_key"],
            row["title"],
            row["artist"],
            row["name"],
            row["count"],
            row["song_count"],
            row["video_count"],
            row["timestamp_count"],
            dumps_json(row["payload"]),
            row["search_text"],
        ),
    )
    if fts_enabled:
        conn.execute("INSERT INTO ranking_fts(row_id, search_text) VALUES (?, ?)", (row["row_id"], row["search_text"]))


def ingest_vsinger_backfill(
    conn: sqlite3.Connection,
    backfill_dir: Path,
    limit_shards: int,
    fts_enabled: bool,
) -> dict[str, int]:
    manifest_path = backfill_dir / "manifest.json"
    counts = empty_external_counts()
    if not manifest_path.exists():
        write_meta(conn, "vsinger_status", "missing")
        return counts

    manifest = read_json(manifest_path)
    source_system = clean_text(manifest.get("sourceSystem")) or "vsinger_moment_http"
    write_meta(conn, "vsinger_status", "loaded")
    write_meta(conn, "vsinger_manifest_generated_at", clean_text(manifest.get("generatedAt")))
    for key, value in (manifest.get("counts") or {}).items():
        write_meta(conn, f"vsinger_manifest_{key}", str(value))

    shards = manifest.get("shards") if isinstance(manifest.get("shards"), dict) else {}
    song_entities_by_external: dict[str, dict] = {}
    song_entities_by_canonical: dict[str, dict] = {}
    videos_by_external: dict[str, dict] = {}
    videos_by_youtube: dict[str, dict] = {}
    song_stats: dict[str, dict] = {}

    for kind in ("songs", "videos", "occurrences"):
        selected_shards = shards.get(kind) if isinstance(shards.get(kind), list) else []
        if limit_shards > 0:
            selected_shards = selected_shards[:limit_shards]
        log_phase("vsinger_kind_start", kind=kind, shards=len(selected_shards))
        for shard_index, shard in enumerate(selected_shards, start=1):
            shard_file = backfill_dir / str(shard.get("file", ""))
            rows = read_json(shard_file)
            if not isinstance(rows, list):
                raise ValueError(f"{shard_file} must contain a JSON array")
            if kind == "songs":
                for row in rows:
                    insert_external_song(conn, source_system, row)
                    remember_external_song(row, song_entities_by_external, song_entities_by_canonical)
                counts["songs"] += len(rows)
            elif kind == "videos":
                for row in rows:
                    insert_external_video(conn, source_system, row)
                    remember_external_video(row, videos_by_external, videos_by_youtube)
                counts["videos"] += len(rows)
            elif kind == "occurrences":
                for row in rows:
                    insert_external_occurrence(conn, source_system, row)
                    record_external_song_stat(
                        song_stats,
                        row,
                        song_entities_by_external,
                        song_entities_by_canonical,
                        videos_by_external,
                        videos_by_youtube,
                    )
                counts["occurrences"] += len(rows)
            if shard_index == 1 or shard_index == len(selected_shards) or shard_index % 25 == 0:
                log_phase(
                    "vsinger_shard_progress",
                    kind=kind,
                    shard=shard_index,
                    shards=len(selected_shards),
                    rows=len(rows),
                    songs=counts["songs"],
                    videos=counts["videos"],
                    occurrences=counts["occurrences"],
                )

    if limit_shards <= 0:
        expected = manifest.get("counts") or {}
        for kind in ("songs", "videos", "occurrences"):
            expected_count = int_or_none(expected.get(kind))
            if expected_count is not None and expected_count != counts[kind]:
                raise ValueError(f"VSinger {kind} count mismatch: {counts[kind]} != {expected_count}")
    ranking_rows = build_external_song_ranking_rows(source_system, song_stats)
    for row in ranking_rows:
        source_detail = row.get("source_detail")
        if source_detail:
            insert_source_detail(
                conn,
                source_detail["source_key"],
                row["range_id"],
                source_detail["entity_type"],
                source_detail["entity_key"],
                source_detail["payload"],
            )
        insert_ranking_row(conn, row, fts_enabled)
    counts["ranking_rows"] = len(ranking_rows)
    write_meta(conn, "vsinger_ranking_rows", str(len(ranking_rows)))
    return counts


def empty_external_counts() -> dict[str, int]:
    return {"songs": 0, "videos": 0, "occurrences": 0, "ranking_rows": 0}


def remember_external_song(row: dict, by_external: dict[str, dict], by_canonical: dict[str, dict]) -> None:
    entity = {
        "externalSongId": clean_text(row.get("externalSongId")),
        "canonicalSongId": clean_text(row.get("canonicalSongId")),
        "title": clean_text(row.get("displayTitle") or row.get("title")),
        "artist": clean_text(row.get("displayArtist") or row.get("artist")),
        "sourceUrl": clean_text(row.get("sourceUrl")),
    }
    if entity["externalSongId"]:
        by_external[entity["externalSongId"]] = entity
    if entity["canonicalSongId"]:
        by_canonical[entity["canonicalSongId"]] = entity


def remember_external_video(row: dict, by_external: dict[str, dict], by_youtube: dict[str, dict]) -> None:
    entity = {
        "externalVideoId": clean_text(row.get("externalVideoId")),
        "youtubeVideoId": clean_text(row.get("youtubeVideoId")),
        "title": clean_text(row.get("title")),
        "singerName": clean_text(row.get("singerName")),
        "streamedAt": clean_text(row.get("streamedAt")),
        "sourceUrl": clean_text(row.get("sourceUrl")),
    }
    if entity["externalVideoId"]:
        by_external[entity["externalVideoId"]] = entity
    if entity["youtubeVideoId"]:
        by_youtube[entity["youtubeVideoId"]] = entity


def record_external_song_stat(
    stats: dict[str, dict],
    occurrence: dict,
    songs_by_external: dict[str, dict],
    songs_by_canonical: dict[str, dict],
    videos_by_external: dict[str, dict],
    videos_by_youtube: dict[str, dict],
) -> None:
    external_song_id = clean_text(occurrence.get("externalSongId"))
    canonical_song_id = clean_text(occurrence.get("canonicalSongId"))
    song_entity = songs_by_external.get(external_song_id) or songs_by_canonical.get(canonical_song_id) or {}
    key = external_song_id or canonical_song_id
    if not key:
        key = stable_key("vsinger-song", canonical_song_id, occurrence.get("youtubeVideoId"), occurrence.get("seconds"))
    if key not in stats:
        title = clean_text(song_entity.get("title"))
        artist = clean_text(song_entity.get("artist"))
        stats[key] = {
            "key": key,
            "externalSongId": external_song_id,
            "canonicalSongId": canonical_song_id,
            "title": title,
            "artist": artist,
            "sourceUrl": clean_text(song_entity.get("sourceUrl")),
            "count": 0,
            "videos": set(),
            "singers": {},
            "occurrence_keys": set(),
            "occurrences": [],
        }
    record = stats[key]
    external_video_id = clean_text(occurrence.get("externalVideoId"))
    youtube_video_id = clean_text(occurrence.get("youtubeVideoId"))
    occurrence_key = stable_key(
        "vsinger-occurrence",
        external_song_id or canonical_song_id,
        youtube_video_id or external_video_id,
        occurrence.get("seconds"),
    )
    if occurrence_key in record["occurrence_keys"]:
        return
    record["occurrence_keys"].add(occurrence_key)
    record["count"] += 1
    if external_song_id and not record["externalSongId"]:
        record["externalSongId"] = external_song_id
    if canonical_song_id and not record["canonicalSongId"]:
        record["canonicalSongId"] = canonical_song_id
    if song_entity:
        record["title"] = record["title"] or clean_text(song_entity.get("title"))
        record["artist"] = record["artist"] or clean_text(song_entity.get("artist"))
        record["sourceUrl"] = record["sourceUrl"] or clean_text(song_entity.get("sourceUrl"))

    video_entity = videos_by_external.get(external_video_id) or videos_by_youtube.get(youtube_video_id) or {}
    video_key_value = youtube_video_id or external_video_id
    if video_key_value:
        record["videos"].add(video_key_value)
    increment_count(record["singers"], clean_text(video_entity.get("singerName")))
    if len(record["occurrences"]) < 20:
        record["occurrences"].append(
            {
                "youtubeVideoId": youtube_video_id,
                "externalVideoId": external_video_id,
                "title": clean_text(video_entity.get("title")),
                "singerName": clean_text(video_entity.get("singerName")),
                "streamedAt": clean_text(video_entity.get("streamedAt")),
                "sourceUrl": clean_text(video_entity.get("sourceUrl")),
                "seconds": int_or_none(occurrence.get("seconds")),
            }
        )


def build_external_song_ranking_rows(source_system: str, stats: dict[str, dict]) -> list[dict]:
    sorted_records = sorted(
        stats.values(),
        key=lambda row: (-row["count"], normalize_key(row["title"]), normalize_key(row["artist"]), row["key"]),
    )
    rows = []
    for rank, record in enumerate(sorted_records, start=1):
        detail_key = f"{source_system}:{record['key']}"
        source_detail_key = stable_key("source-vsinger-song", detail_key)
        payload = {
            "type": "song",
            "sourceSystem": source_system,
            "key": detail_key,
            "externalSongId": record["externalSongId"],
            "canonicalSongId": record["canonicalSongId"],
            "title": record["title"],
            "displayArtist": record["artist"],
            "sourceUrl": record["sourceUrl"],
            "count": record["count"],
            "videoCount": len(record["videos"]),
            "timestampCount": record["count"],
            "singers": count_map_to_list(record["singers"]),
            "occurrences": record["occurrences"],
            "sourceDetailKey": source_detail_key,
        }
        row = {
            "key": detail_key,
            "title": record["title"],
            "artist": record["artist"],
            "name": "",
            "count": record["count"],
            "video_count": len(record["videos"]),
            "timestamp_count": record["count"],
            "payload": payload,
            "search_text": search_text(record["title"], record["artist"], *record["singers"].keys()),
            "source_detail": {
                "source_key": source_detail_key,
                "entity_type": "vsingerSong",
                "entity_key": detail_key,
                "payload": {**payload, "occurrencePreviewLimited": len(record["occurrences"]) >= 20},
            },
        }
        rows.append(row_payload("all", "vsingerSongs", rank, row))
    return rows


def insert_external_song(conn: sqlite3.Connection, source_system: str, row: dict) -> None:
    source = clean_text(row.get("sourceSystem")) or source_system
    external_song_id = clean_text(row.get("externalSongId") or row.get("canonicalSongId"))
    if not external_song_id:
        external_song_id = stable_key("external-song", dumps_json(row))
    conn.execute(
        """
        INSERT OR REPLACE INTO external_songs(
          source_system, external_song_id, canonical_song_id, title, artist, source_url, payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            source,
            external_song_id,
            clean_text(row.get("canonicalSongId")),
            clean_text(row.get("displayTitle") or row.get("title")),
            clean_text(row.get("displayArtist") or row.get("artist")),
            clean_text(row.get("sourceUrl")),
            dumps_json(row),
        ),
    )


def insert_external_video(conn: sqlite3.Connection, source_system: str, row: dict) -> None:
    source = clean_text(row.get("sourceSystem")) or source_system
    external_video_id = clean_text(row.get("externalVideoId") or row.get("youtubeVideoId"))
    if not external_video_id:
        external_video_id = stable_key("external-video", dumps_json(row))
    conn.execute(
        """
        INSERT OR REPLACE INTO external_videos(
          source_system, external_video_id, youtube_video_id, title, singer_name, streamed_at, source_url, payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            source,
            external_video_id,
            clean_text(row.get("youtubeVideoId")),
            clean_text(row.get("title")),
            clean_text(row.get("singerName")),
            clean_text(row.get("streamedAt")),
            clean_text(row.get("sourceUrl")),
            dumps_json(row),
        ),
    )


def insert_external_occurrence(conn: sqlite3.Connection, source_system: str, row: dict) -> None:
    source = clean_text(row.get("sourceSystem")) or source_system
    occurrence_id = clean_text((row.get("provenance") or {}).get("hash"))
    if not occurrence_id:
        occurrence_id = stable_key(
            "external-occurrence",
            row.get("youtubeVideoId"),
            row.get("externalVideoId"),
            row.get("externalSongId"),
            row.get("canonicalSongId"),
            row.get("seconds"),
        )
    conn.execute(
        """
        INSERT OR REPLACE INTO external_occurrences(
          source_system, occurrence_id, canonical_song_id, external_song_id, external_video_id,
          youtube_video_id, seconds, payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            source,
            occurrence_id,
            clean_text(row.get("canonicalSongId")),
            clean_text(row.get("externalSongId")),
            clean_text(row.get("externalVideoId")),
            clean_text(row.get("youtubeVideoId")),
            int_or_none(row.get("seconds")),
            dumps_json(row),
        ),
    )


def upsert_video(conn: sqlite3.Connection, video_id: str, item: dict) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO videos(
          video_id, title, channel_name, channel_id, channel_handle, channel_url, keyword,
          published_timestamp, published_text, duration_text, thumbnail_url, payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            video_id,
            clean_text(item.get("title")),
            clean_text(item.get("channelName")),
            clean_text(item.get("channelId")),
            clean_text(item.get("channelHandle")),
            clean_text(item.get("channelUrl") or item.get("authorUrl") or item.get("ownerUrl")),
            clean_text(item.get("keyword")),
            int_or_none(item.get("publishedTimestamp")),
            clean_text(item.get("publishedText")),
            clean_text(item.get("durationText")),
            clean_text(item.get("thumbnailUrl") or item.get("thumbnail")),
            dumps_json(item),
        ),
    )


def upsert_channel_metadata(conn: sqlite3.Connection, item: dict) -> None:
    channel_key = channel_record_key(item)
    if not channel_key:
        return
    channel_url = clean_text(item.get("channelUrl") or item.get("authorUrl") or item.get("ownerUrl"))
    payload = {
        "channelId": clean_text(item.get("channelId")),
        "handle": clean_text(item.get("channelHandle")),
        "displayName": clean_text(item.get("channelName") or item.get("channelHandle") or item.get("channelId")),
        "avatarUrl": clean_text(item.get("avatarUrl") or item.get("channelAvatarUrl")),
        "thumbnailUrl": vtuber_thumbnail_candidate(item),
        "sourceUrl": clean_text(item.get("sourceUrl") or channel_url),
        "channelUrl": channel_url,
        "knownSourceType": clean_text(item.get("knownSourceType")) or known_source_type(item),
        "isCollected": is_collected_source(item),
    }
    conn.execute(
        """
        INSERT INTO channel_metadata(
          channel_key, channel_id, handle, display_name, avatar_url, thumbnail_url, source_url, channel_url,
          known_source_type, is_collected, payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_key) DO UPDATE SET
          channel_id=COALESCE(NULLIF(channel_metadata.channel_id, ''), excluded.channel_id),
          handle=COALESCE(NULLIF(channel_metadata.handle, ''), excluded.handle),
          display_name=COALESCE(NULLIF(channel_metadata.display_name, ''), excluded.display_name),
          avatar_url=COALESCE(NULLIF(channel_metadata.avatar_url, ''), excluded.avatar_url),
          thumbnail_url=COALESCE(NULLIF(channel_metadata.thumbnail_url, ''), excluded.thumbnail_url),
          source_url=COALESCE(NULLIF(channel_metadata.source_url, ''), excluded.source_url),
          channel_url=COALESCE(NULLIF(channel_metadata.channel_url, ''), excluded.channel_url),
          known_source_type=CASE
            WHEN channel_metadata.known_source_type IN ('vsinger_moment_http', 'vsinger-moment', 'moment')
             AND excluded.known_source_type NOT IN ('', 'vsinger_moment_http', 'vsinger-moment', 'moment')
            THEN excluded.known_source_type
            ELSE COALESCE(NULLIF(channel_metadata.known_source_type, ''), excluded.known_source_type)
          END,
          is_collected=MAX(channel_metadata.is_collected, excluded.is_collected),
          payload_json=excluded.payload_json
        """,
        (
            channel_key,
            payload["channelId"],
            payload["handle"],
            payload["displayName"],
            payload["avatarUrl"],
            payload["thumbnailUrl"],
            payload["sourceUrl"],
            payload["channelUrl"],
            payload["knownSourceType"],
            1 if payload["isCollected"] else 0,
            dumps_json(payload),
        ),
    )


def upsert_song(conn: sqlite3.Connection, song_key: str, song: dict) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO songs(song_key, title, artist, is_niche, payload_json)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            song_key,
            clean_text(song.get("title")),
            clean_text(song.get("artist")),
            1 if song.get("isNiche") is True else 0,
            dumps_json(song),
        ),
    )


def insert_occurrence(
    conn: sqlite3.Connection,
    occurrence_id: str,
    range_id: str,
    video_id: str,
    song_key: str,
    item: dict,
    song: dict,
) -> None:
    payload = {
        "rangeId": range_id,
        "videoId": video_id,
        "song": compact_song(song),
        "video": compact_video(item),
    }
    conn.execute(
        """
        INSERT OR IGNORE INTO occurrences(
          occurrence_id, range_id, video_id, song_key, seconds, source_system, source_id, title, artist, payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            occurrence_id,
            range_id,
            video_id,
            song_key,
            int_or_none(song.get("seconds")),
            clean_text(song.get("sourceSystem")) or clean_text((item.get("sourceQuality") or {}).get("sourceSystem")) or "latest_json",
            clean_text(song.get("sourceId") or song.get("sourceHash")),
            clean_text(song.get("title")),
            clean_text(song.get("artist")),
            dumps_json(payload),
        ),
    )


def insert_source_detail(conn: sqlite3.Connection, source_key: str, range_id: str, entity_type: str, entity_key: str, payload: dict) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO source_details(source_key, range_id, entity_type, entity_key, payload_json)
        VALUES (?, ?, ?, ?, ?)
        """,
        (source_key, range_id, entity_type, entity_key, dumps_json(payload)),
    )


def insert_source_occurrences_for_detail(conn: sqlite3.Connection, source_key: str, range_id: str, payload: dict) -> int:
    occurrences = payload.get("occurrences") if isinstance(payload.get("occurrences"), list) else []
    for position, occurrence in enumerate(occurrences):
        if isinstance(occurrence, dict):
            insert_source_occurrence(conn, source_key, range_id, position, occurrence)
    return len(occurrences)


def insert_source_occurrence(conn: sqlite3.Connection, source_key: str, range_id: str, position: int, payload: dict) -> None:
    item = payload.get("item") if isinstance(payload.get("item"), dict) else {}
    song = payload.get("song") if isinstance(payload.get("song"), dict) else {}
    occurrence_search_text = clean_text(payload.get("searchText")) or search_text(
        item.get("videoId"),
        item.get("title"),
        item.get("channelName"),
        item.get("channelId"),
        item.get("channelHandle"),
        item.get("channelUrl") or item.get("authorUrl") or item.get("ownerUrl"),
        item.get("keyword"),
        song.get("title"),
        song.get("artist"),
    )
    conn.execute(
        """
        INSERT OR REPLACE INTO source_occurrences(
          source_key, range_id, position, video_id, title, channel_name, published_timestamp, seconds, search_text, payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            source_key,
            range_id,
            position,
            clean_text(item.get("videoId")),
            clean_text(item.get("title")),
            clean_text(item.get("channelName")),
            int_or_none(item.get("publishedTimestamp")),
            int_or_none(song.get("seconds")),
            occurrence_search_text,
            dumps_json(payload),
        ),
    )


def append_preview_occurrence(preview: list[dict], item: dict, song: dict, video_id: str) -> None:
    if len(preview) >= 20:
        return
    preview.append(
        {
            "videoId": video_id,
            "title": clean_text(item.get("title")),
            "channelName": clean_text(item.get("channelName")),
            "publishedTimestamp": int_or_none(item.get("publishedTimestamp")),
            "publishedText": clean_text(item.get("publishedText")),
            "seconds": int_or_none(song.get("seconds")),
            "song": compact_song(song),
        }
    )


def occurrence_preview_search_parts(occurrences: list[dict]):
    for occurrence in occurrences or []:
        yield occurrence.get("videoId")
        yield occurrence.get("title")
        yield occurrence.get("channelName")
        song = occurrence.get("song") if isinstance(occurrence.get("song"), dict) else {}
        yield song.get("title")
        yield song.get("artist")


def source_payload_for_video(item: dict, songs: list[dict]) -> dict:
    payload = compact_video(item)
    payload["songs"] = [compact_song(song) for song in songs]
    payload["songCount"] = len(songs)
    return payload


def compact_video(item: dict) -> dict:
    published_timestamp = int_or_none(item.get("publishedTimestamp"))
    return {
        "videoId": clean_text(item.get("videoId")),
        "title": clean_text(item.get("title")),
        "channelName": clean_text(item.get("channelName")),
        "channelId": clean_text(item.get("channelId")),
        "channelHandle": clean_text(item.get("channelHandle")),
        "channelUrl": clean_text(item.get("channelUrl") or item.get("authorUrl") or item.get("ownerUrl")),
        "avatarUrl": clean_text(item.get("avatarUrl") or item.get("channelAvatarUrl")),
        "sourceUrl": clean_text(item.get("sourceUrl") or item.get("channelUrl") or item.get("authorUrl") or item.get("ownerUrl")),
        "knownSourceType": clean_text(item.get("knownSourceType")) or known_source_type(item),
        "isCollected": is_collected_source(item),
        "keyword": clean_text(item.get("keyword")),
        "publishedTimestamp": published_timestamp,
        "publishedAt": timestamp_to_iso(published_timestamp),
        "timeMissingReason": "" if published_timestamp else time_missing_reason(item),
        "publishedText": clean_text(item.get("publishedText")),
        "durationText": clean_text(item.get("durationText")),
        "thumbnailUrl": clean_text(item.get("thumbnailUrl") or item.get("thumbnail")),
    }


def known_source_type(item: dict) -> str:
    source_groups = item.get("sourceGroups") if isinstance(item.get("sourceGroups"), list) else []
    if "youtube_channel_discovery" in source_groups:
        return "youtube_channel_discovery"
    if "vsinger-moment" in source_groups:
        return "vsinger_moment_http"
    source_quality = item.get("sourceQuality") if isinstance(item.get("sourceQuality"), dict) else {}
    return clean_text(source_quality.get("sourceSystem"))


def should_replace_known_source_type(current, incoming) -> bool:
    incoming_type = clean_text(incoming)
    if not incoming_type:
        return False
    current_type = clean_text(current)
    if not current_type:
        return True
    return is_moment_source_type(current_type) and not is_moment_source_type(incoming_type)


def is_moment_source_type(value) -> bool:
    return clean_text(value).lower() in {"vsinger_moment_http", "vsinger-moment", "moment"}


def is_collected_source(item: dict) -> bool:
    source_groups = item.get("sourceGroups") if isinstance(item.get("sourceGroups"), list) else []
    source_quality = item.get("sourceQuality") if isinstance(item.get("sourceQuality"), dict) else {}
    known_type = clean_text(item.get("knownSourceType") or known_source_type(item)).lower()
    true_types = {"manual", "verified", "song-search", "song_search", "youtube_channel_discovery"}
    if (
        "youtube_channel_discovery" in source_groups
        or known_type in true_types
        or (
            source_quality.get("sourceType") == "external"
            and clean_text(source_quality.get("sourceSystem")).lower() != "vsinger_moment_http"
        )
    ):
        return True
    if is_moment_source(item):
        return False
    explicit = item.get("isCollected")
    return explicit is True or explicit == 1 or clean_text(explicit).lower() == "true"


def is_moment_source(item: dict) -> bool:
    source_groups = item.get("sourceGroups") if isinstance(item.get("sourceGroups"), list) else []
    source_quality = item.get("sourceQuality") if isinstance(item.get("sourceQuality"), dict) else {}
    known_type = clean_text(item.get("knownSourceType") or source_quality.get("sourceSystem")).lower()
    return (
        "vsinger-moment" in source_groups
        or is_moment_source_type(known_type)
        or clean_text(source_quality.get("sourceSystem")).lower() == "vsinger_moment_http"
    )


def runtime_scoped_songs(songs, source: dict | None = None) -> list[dict]:
    if not isinstance(songs, list):
        return []
    return [song for song in songs if isinstance(song, dict) and clean_text(song.get("title")) and not is_likely_runtime_non_song_entry(song, source)]


def is_likely_runtime_non_song_entry(song: dict, source: dict | None = None) -> bool:
    title = clean_text(song.get("title"))
    artist = clean_text(song.get("artist"))
    raw = clean_text(song.get("raw"))
    if not title:
        return True
    if is_runtime_confirmed_dirty_title(title, raw):
        return True
    if is_runtime_topic_like_bilingual_commentary(title, artist, raw):
        return True
    unknown_artist = is_unknown_artist(artist)
    if unknown_artist and is_channel_scoped_unknown_artist_dirty_song(source):
        return True
    if unknown_artist and is_source_self_reference_title(title, source):
        return True
    if unknown_artist and is_standalone_non_song_marker(title):
        return True
    combined = f"{title} {raw}"
    if unknown_artist and re.search(r"(?:set\s*list|setlist|timestamp|timestamps|セットリスト|セトリ|タイムスタンプ|曲名|歌唱開始時間)", combined, re.IGNORECASE):
        return True
    if unknown_artist and is_runtime_commentary_noise(title, raw):
        return True
    if unknown_artist and is_bracketed_runtime_commentary_note(title):
        return True
    return False


def is_runtime_confirmed_dirty_title(title, raw) -> bool:
    title_text = normalize_runtime_commentary_text(title)
    combined = normalize_runtime_commentary_text(f"{title} {raw}")
    if not title_text:
        return True
    if is_bracketed_runtime_commentary_note(title):
        return True
    if re.search(r"(?:自己肯定感|なれたん|naraetan)", combined, re.IGNORECASE):
        return True
    if is_runtime_conversational_pseudo_song(title, raw):
        return True
    return bool(re.search(r"^(?:雑談|聊天|说明|説明|コメント|コメ|アンケート|投票|リクエスト)(?:確認|募集|受付|結果|タイム|ください|下さい|中|する|して|お願いします|お願い)?$", title_text, re.IGNORECASE))


def is_channel_scoped_unknown_artist_dirty_song(source: dict | None) -> bool:
    if not isinstance(source, dict):
        return False
    handle_values = [
        source.get("channelHandle"),
        source.get("handle"),
        source.get("ownerHandle"),
        source.get("channelUrl"),
        source.get("authorUrl"),
        source.get("ownerUrl"),
    ]
    if any(normalize_handle(value) == "isakiriona" for value in handle_values):
        return True
    channel_name = normalize_key(
        clean_text(source.get("channelName"))
        or clean_text(source.get("ownerText"))
        or clean_text(source.get("longBylineText"))
        or clean_text(source.get("shortBylineText"))
    )
    return "響咲リオナ" in channel_name or channel_name.startswith("riona ch.")


def is_source_self_reference_title(title, source: dict | None) -> bool:
    if not isinstance(source, dict):
        return False
    title_key = normalize_channel_identity_title(title)
    if len(title_key) < 3:
        return False
    channel_candidates = [
        source.get("channelName"),
        source.get("ownerText"),
        source.get("longBylineText"),
        source.get("shortBylineText"),
        source.get("authorName"),
        source.get("authorText"),
    ]
    for value in channel_candidates:
        candidate = normalize_channel_identity_title(value)
        if candidate and (candidate == title_key or title_key in candidate):
            return True
    handle_candidates = [
        source.get("channelHandle"),
        source.get("handle"),
        source.get("ownerHandle"),
        source.get("channelUrl"),
        source.get("authorUrl"),
        source.get("ownerUrl"),
    ]
    for value in handle_candidates:
        handle = normalize_handle(value)
        if handle and (handle == title_key or re.sub(r"ch(?:annel)?$", "", handle, flags=re.IGNORECASE) == title_key):
            return True
    return False


def normalize_handle(value) -> str:
    text = clean_text(value)
    text = re.sub(r"^https?://(?:www\.)?youtube\.com/", "", text, flags=re.IGNORECASE)
    text = text.lstrip("/").split("?")[0].split("#")[0].split("/")[0].lstrip("@").strip()
    return text.lower() if re.fullmatch(r"[A-Za-z0-9._-]+", text) else ""


def normalize_channel_identity_title(value) -> str:
    text = unicodedata.normalize("NFKC", clean_text(value)).lower()
    text = re.sub(r"(?:ch\.?|channel|チャンネル|公式|official|歌枠|karaoke|cover|vtuber|live|配信)$", "", text, flags=re.IGNORECASE)
    text = re.sub(r"[\U0001F300-\U0001FAFF\uFE0E\uFE0F♪♫♬♩]", "", text)
    text = re.sub(r"[\s\u3000\[\]【】()（）「」『』\"'“”‘’~～!！?？.,，。、:：;；\-—–−_・･/／|｜@]+", "", text)
    return text.strip()


def is_runtime_commentary_noise(title, raw) -> bool:
    combined = normalize_runtime_commentary_text(f"{title} {raw}")
    title_text = normalize_runtime_commentary_text(title)
    if not title_text:
        return False
    if re.search(r"(?:雑談|聊天|说明|説明|コメント|コメ|アンケート|投票|リクエスト|配信|歌枠|喉|のど|自己紹介|お知らせ|告知|自己肯定感)", title_text, re.IGNORECASE):
        return True
    if re.search(r"(?:なれコール)?アンケート|歌詞考察|曲紹介(?:タイム)?", title_text, re.IGNORECASE):
        return True
    if re.search(r"(?:なれたん|naraetan)", combined, re.IGNORECASE):
        return True
    if re.search(r"(?:について|のお話|問題|しよう|している|していない|だった|でした|です|ます|ありがとう|おめでとう|気がする|したい|してください|なんで|かな|かも|だよ|だね|なの|か)$", title_text, re.IGNORECASE):
        return True
    if re.search(r"(?:背景を変える|食べる|飲む|お名前呼び|チャンネル登録|スパチャ|メンシ|スクショ|サムネ|写真|登録|ギフト|曲紹介|歌うフリ|姉|妹|幼馴染|指が細い|身長が低い|家族に例える)", combined, re.IGNORECASE):
        return True
    return False


def is_runtime_conversational_pseudo_song(title, raw) -> bool:
    title_text = normalize_runtime_commentary_text(title)
    combined = normalize_runtime_commentary_text(f"{title} {raw}")
    if not title_text:
        return False
    if re.fullmatch(r"(?:おはよう|おはよ|こんにちは|こんばんは|こん[\wー~〜～]{2,20}|おつ[\wー~〜～]{1,24}|またね|ばいばい|bye)", title_text, re.IGNORECASE):
        return True
    if re.fullmatch(r"(?:ご挨拶|挨拶|雑談|聊天|閑談|コメント|コメ|感想|日常|近況)(?:タイム|枠|中|する|です)?", title_text, re.IGNORECASE):
        return True
    if re.fullmatch(r"(?:次(?:の)?バトンは|次は).{2,40}(?:ちゃん|さん|くん)", title_text):
        return True
    if re.search(r"(?:次(?:の)?バトンは|嫁|お嫁|旦那|推し|リスナー|視聴者|チャンネル登録|高評価|スパチャ|メンシ|コメント|コメ|雑談|聊天|閑談|日常|近況)", combined):
        return bool(re.search(r"(?:ちゃん|さん|くん|だよ|です|ます|でした|だった|ありがとう|おめでとう|よろしく|お疲れ|おつかれ)", combined))
    return False


def is_runtime_topic_like_bilingual_commentary(title, artist, raw) -> bool:
    title_text = clean_text(title)
    artist_text = clean_text(artist)
    raw_text = clean_text(raw)
    if not title_text or not artist_text:
        return False
    if is_known_song_safe_from_runtime_commentary(title_text, artist_text):
        return False
    if has_structured_song_number(raw_text) and not is_runtime_commentary_noise(title_text, raw_text):
        return False
    if not contains_japanese(title_text) or contains_japanese(artist_text):
        return False
    if not is_english_gloss_like_text(artist_text):
        return False
    if is_runtime_commentary_noise(title_text, raw_text) or is_runtime_sentence_like_title(title_text):
        return True
    return bool(re.search(r"(?:op|ed|opening|ending|雑談|日常|閑談|問候|挨拶|感想|紹介|説明|韓国|韓国人|日本|日本語|英語|発音|長音|病院|食|飯|飲|茶|酒|炭酸|ドリンク|餅|音楽停止|クリック|おすすめ|曲紹介|歌詞考察|考察|アンケート|リクエスト|コメント|コメ|家族|両親|姉|妹|幼馴染|身長|指|チャンネル|登録|美容院|カラオケ|ドラマ|お土産|夢|広告|写真|リスク|違い|難しい|ちゃんぽん|キムチ|ソーマ)", title_text, re.IGNORECASE))


def is_known_song_safe_from_runtime_commentary(title, artist) -> bool:
    title_text = clean_text(title)
    artist_text = clean_text(artist)
    if "星座になれたら" in title_text:
        return True
    if re.fullmatch(r"START:DASH!!", title_text, re.IGNORECASE) and artist_text and not is_unknown_artist(artist_text):
        return True
    return bool(re.fullmatch(r"(?:ENDLESS STORY|Never Ending Story|Opening|Ending)", title_text, re.IGNORECASE) and artist_text and not is_unknown_artist(artist_text))


def has_structured_song_number(raw) -> bool:
    value = re.sub(r"^\s*(?:[\[【(（]\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*(?:[\]】)）])?\s*", "", clean_text(raw))
    return bool(re.search(r"(?:^|[\s　])#?\d{1,3}\s*[.)．、）:：]", value) or re.search(r"(?:^|[\s　])#\d{1,3}\s+", value))


def is_runtime_sentence_like_title(text) -> bool:
    value = clean_text(text)
    if not value:
        return False
    if len(value) >= 18 and re.search(r"(?:だった|でした|です|ます|して|した|する|され|たい|ない|ある|いる|なる|なった|くる|行く|来る|思う|忘れ|信じ|疑う|食べ|飲み|寝て|痛い|怖い|楽しい|辛い|欲しい|ください|お願い|かな|ですね|ですよ|だよ|なの|のか|のは|とは|って|コメ|コメント)", value):
        return True
    return bool(re.fullmatch(r"[^/／|｜]{1,40}[?？]", value) and re.search(r"(?:なれたん|人|何|どこ|いる|する|です|ます|なの|のか)", value))


def is_english_gloss_like_text(text) -> bool:
    value = unicodedata.normalize("NFKC", clean_text(text))
    if not value or contains_japanese(value) or not re.search(r"[A-Za-z]", value):
        return False
    if not re.fullmatch(r"[A-Za-z0-9 .,:'’\"“”&+_\-/!?~()[\]#]+", value):
        return False
    words = re.findall(r"[A-Za-z][A-Za-z'’]*", value)
    if not words or len(words) > 18:
        return False
    if is_runtime_sentence_like_credit(value):
        return True
    if re.search(r"[?？]$", value) or re.search(r"\([^)]{3,80}\)", value):
        return True
    return bool(re.search(r"\b(?:about|accidental|accented|ad|alcohol|anime|attack|ballad|carbonated|catchy|click|commercial|differences?|difficult|dream|drink(?:ing)?|food|hospital|introduced?|introducing|japanese|korean|marks?|music|parents?|picture|poisoning|poll|popular|pronunciation|recommendations?|recently|rice|risks?|salon|song|songs|souvenirs?|stops?|tea|temptation|traditional|vowel|watched)\b", value, re.IGNORECASE))


def is_runtime_sentence_like_credit(text) -> bool:
    value = clean_text(text)
    if not value or is_unknown_artist(value):
        return False
    if re.match(r"(?:Recommended|Poll:|Are you trying|I envy|I(?:’|'|)ll pretend|Older Sister|Younger Sister|.+\?)\b", value, re.IGNORECASE):
        return True
    return bool(len(value) >= 24 and re.search(r"\s", value) and re.search(r"\b(?:i|you|we|my|your|the|a|an|to|that|this|was|were|is|are|be|being|been|have|has|had|do|does|did|can|can't|cannot|will|want|trying|because|with|from|about|people|song|comment|viewers|family|friend|reason|recommended|pretend|believe|forgot)\b", value, re.IGNORECASE))


def contains_japanese(text) -> bool:
    return bool(re.search(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", clean_text(text)))


def normalize_runtime_commentary_text(value) -> str:
    text = unicodedata.normalize("NFKC", clean_text(value))
    text = re.sub(r"[:：]_[^\s　:：]+[:：]?", "", text)
    text = re.sub(r"[\u200b-\u200f\u202a-\u202e\ufe0e\ufe0f]", "", text)
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"[!！?？。．.]+$", "", text)
    return text.strip()


def is_bracketed_runtime_commentary_note(value) -> bool:
    text = unicodedata.normalize("NFKC", clean_text(value)).strip()
    match = re.fullmatch(r"[\[【(（「『]\s*([^\[\]()（）【】「」『』]{1,80})\s*[\]】)）」』]", text)
    if match and is_runtime_commentary_note_text(match.group(1)):
        return True
    match = re.match(r"^[\[【(（「『]\s*([^\[\]()（）【】「」『』]{1,80})\s*[\]】)）」』]\s*(.{0,80})$", text)
    return bool(match and (is_runtime_commentary_note_text(match.group(1)) or is_runtime_commentary_note_text(match.group(2))))


def is_runtime_commentary_note_text(value) -> bool:
    text = normalize_runtime_commentary_text(value)
    return bool(text and re.search(r"(?:雑談|聊天|说明|説明|告知|コメント|コメ|アンケート|リクエスト|配信|歌枠|喉|のど|自己紹介|なれたん|去年|練習|家族|姉|妹|幼馴染|身長|指|チャンネル|登録|スパチャ|メンシ|スクショ|写真|サムネ)", text, re.IGNORECASE))


def is_standalone_non_song_marker(value) -> bool:
    marker = normalize_standalone_marker(value)
    if not marker:
        return False
    if re.fullmatch(r"(?:op|ed|end|opening|ending|openingtalk|endingtalk|streamstart|streamend|streamended|karaokestart|karaokeend)", marker, re.IGNORECASE):
        return True
    if re.fullmatch(r"(?:setlist|timestamp|timestamps)", marker, re.IGNORECASE):
        return True
    return marker in {
        "本編開始",
        "本編終了",
        "全曲終了",
        "配信開始",
        "配信終了",
        "開始",
        "終了",
        "セットリスト",
        "セトリ",
        "タイムスタンプ",
        "曲名",
        "歌唱開始時間",
    }


def normalize_standalone_marker(value) -> str:
    text = unicodedata.normalize("NFKC", clean_text(value))
    text = re.sub(r"[【】\[\]「」『』\"'“”‘’]", "", text)
    text = re.sub(r"^[\s~〜～・･:：\-—–−/／|｜￤∣丨]+|[\s~〜～・･:：\-—–−/／|｜￤∣丨]+$", "", text)
    text = re.sub(r"[\s~〜～・･:：\-—–−/／|｜￤∣丨]+", "", text)
    return text.strip()


def timestamp_to_iso(value: int | None) -> str:
    if not value:
        return ""
    return dt.datetime.fromtimestamp(value / 1000, tz=dt.timezone.utc).isoformat().replace("+00:00", "Z")


def time_missing_reason(item: dict) -> str:
    if not clean_text(item.get("videoId")):
        return "missing_video_id"
    return "youtube_published_timestamp_unavailable"


def compact_song(song: dict) -> dict:
    return {
        "title": clean_text(song.get("title")),
        "artist": clean_text(song.get("artist")),
        "seconds": int_or_none(song.get("seconds")),
        "time": clean_text(song.get("time")),
        "raw": clean_text(song.get("raw")),
        "isNiche": song.get("isNiche") is True,
    }


def count_map_to_list(value: dict[str, int]) -> list[dict]:
    records = []
    for name, count in value.items():
        if isinstance(count, dict):
            records.append({"name": clean_text(count.get("name") or name), "count": int(count.get("count") or 0)})
        elif name:
            records.append({"name": name, "count": int(count or 0)})
    return [record for record in sorted(records, key=lambda item: (-item["count"], normalize_key(item["name"]))) if record["name"]]


def increment_vtuber_song_count(target: dict[str, dict], song: dict) -> None:
    title = vtuber_canonical_song_title(song.get("title"))
    key = vtuber_song_identity_key(title)
    if not key or not title:
        return
    if key not in target:
        target[key] = {"name": title, "count": 0}
    target[key]["count"] += 1


def vtuber_canonical_song_title(value) -> str:
    title = clean_text(value)
    if not title:
        return ""
    for _ in range(4):
        next_title = unicodedata.normalize("NFKC", title)
        next_title = re.sub(r"^\s*[#＃]?\d{1,4}\s*[\U00002600-\U000027BF\U0001F300-\U0001FAFF\uFE0F♪♫♬♩▶▷►▸▹>|・･●○◆◇■□]+", "", next_title)
        next_title = re.sub(r"^\s*[＊*]?\s*(?:[#＃]?\d{1,4}|[０-９]{1,4})\s*(?:曲目|曲|番目)?\s*[.)．。、,,:：)）\]\-|｜/／]+\s*", "", next_title)
        next_title = next_title.strip()
        if next_title == title:
            break
        title = next_title
    title = strip_trailing_latin_gloss(title)
    title = normalize_song_work_title(title)
    return strip_trailing_latin_gloss(title)


def normalize_song_work_title(value) -> str:
    text = strip_leading_title_list_marker(clean_text(value))
    if not text:
        return ""
    bracket = re.match(r"^(.+?)\s*[(（［\[【「『]\s*([^()（）\[\]［］【】「」『』]{1,80})\s*[)）］\]】」』]\s*$", text)
    if bracket and is_whitelisted_song_variant(bracket.group(2)):
        return bracket.group(1).strip()
    separated = re.match(r"^(.+?)\s*(?:[-ー–—|｜:：/／])\s*(.{1,80})\s*$", text)
    if separated and is_whitelisted_song_variant(separated.group(2)):
        return separated.group(1).strip()
    spaced = re.match(r"^(.+?)\s+(.{1,80})\s*$", text)
    if spaced and is_whitelisted_song_variant(spaced.group(2)):
        return spaced.group(1).strip()
    trailing_index = re.match(r"^(.+?)\s+(?:[#＃]?\d{1,3}\s*(?:曲目|曲|番目))\s*$", text)
    if trailing_index:
        return trailing_index.group(1).strip()
    return text


def strip_leading_title_list_marker(value) -> str:
    result = clean_text(value)
    for _ in range(4):
        next_value = re.sub(r"^\s*[╟├└│┃┏┗┣┳┻━─┬┴┌┐┘┤┼▶▷►▸▹>|・･●○◆◇■□♪♫♬♩♡♥◎★☆\uFE0F\U00002600-\U000027BF\U0001F300-\U0001FAFF⁅⁆]+", "", result)
        next_value = re.sub(r"^\s*[＊*]\s*(?=(?:[#＃]?\d{1,3}[.．](?![0-9０-９])|[#＃]?\d{1,3}[)）、:：]|[\u2460-\u2473\u24f5-\u24fe\u2776-\u2793\u3251-\u325f\u32b1-\u32bf]))", "", next_value)
        next_value = re.sub(r"^\s*[\u2460-\u2473\u24f5-\u24fe\u2776-\u2793\u3251-\u325f\u32b1-\u32bf]\s*", "", next_value)
        next_value = re.sub(r"^\s*(?:[#＃]?\d{1,3}|[0-9０-９]{1,3})\s*(?:曲目|曲|番目)\s*(?:[.．。、,,:：)）\]\-|｜/／]+|\s+)", "", next_value)
        next_value = re.sub(r"^\s*(?:(?:[#＃]?\d{1,3}|[0-9０-９]{1,3})[\s。、,,:：)）\]\-|｜/／]+|(?:[#＃]?\d{1,3}|[0-9０-９]{1,3})[.．](?![0-9０-９])\s*)", "", next_value)
        if next_value == result:
            break
        result = next_value
    return result.strip()


def is_whitelisted_song_variant(value) -> bool:
    text = clean_text(value).lstrip(" :：-ー–—|｜/／").strip()
    return bool(
        re.match(
            r"^(?:piano\s*(?:ver\.?|version)?|ピアノ\s*(?:ver\.?|版)?|acoustic\s*(?:ver\.?|version)?|アコースティック|弾き語り|a\s*cappella|acappella|アカペラ|short\s*(?:ver\.?|version)?|full\s*(?:ver\.?|version)?|tv\s*size|key\s*[+-]\s*\d+|キー\s*[+-]?\s*\d+|原キー|キー変更)$",
            text,
            re.IGNORECASE,
        )
    )


def strip_trailing_latin_gloss(value) -> str:
    text = unicodedata.normalize("NFKC", clean_text(value))
    if not text:
        return ""
    separated = re.match(r"^(.+?)\s+(?:[-–—])\s+([A-Za-z][A-Za-z0-9 .,'’\"“”&+_/!?()[\]-]{1,80})$", text)
    if separated and vtuber_contains_japanese(separated.group(1)):
        return separated.group(1).strip()
    bracketed = re.match(r"^(.+?)\s*[(（［\[]\s*([A-Za-z][A-Za-z0-9 .,'’\"“”&+_/!?()[\]-]{1,80})\s*[)）］\]]$", text)
    if bracketed and vtuber_contains_japanese(bracketed.group(1)):
        return bracketed.group(1).strip()
    return text


def vtuber_song_identity_key(value) -> str:
    text = unicodedata.normalize("NFKC", clean_text(value)).lower()
    return "".join(ch for ch in text if unicodedata.category(ch)[0] in {"L", "N"})


def vtuber_contains_japanese(value) -> bool:
    return bool(re.search(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", clean_text(value)))


def increment_count(target: dict[str, int], value: str) -> None:
    if not value:
        return
    target[value] = target.get(value, 0) + 1


def group_for_range(groups: dict, range_id: str) -> dict | None:
    candidates = (range_id, *LEGACY_RANGE_IDS.get(range_id, ()))
    for candidate in candidates:
        group = groups.get(candidate)
        if isinstance(group, dict):
            return group
    return None


def video_key(item: dict) -> str:
    video_id = clean_text(item.get("videoId"))
    if video_id:
        return video_id
    return stable_key("video", item.get("channelName"), item.get("title"), item.get("publishedTimestamp"))


def song_record_key(song: dict) -> str:
    source_key = clean_text(song.get("key") or song.get("canonicalSongId"))
    if source_key:
        return source_key
    return stable_key("song", normalize_key(song.get("title")), normalize_key(song.get("artist")))


def channel_record_key(item: dict) -> str:
    channel_id = clean_text(item.get("channelId"))
    if channel_id:
        return channel_id
    channel_handle = clean_text(item.get("channelHandle")).lstrip("/")
    if channel_handle:
        return normalize_key(channel_handle)
    channel_url_handle = handle_from_channel_url(item.get("channelUrl") or item.get("authorUrl") or item.get("ownerUrl")).lstrip("/")
    if channel_url_handle:
        return normalize_key(channel_url_handle)
    channel_name = clean_text(item.get("channelName"))
    if is_composite_channel_name(channel_name):
        return ""
    return normalize_key(channel_name) if channel_name else ""


def is_composite_channel_name(value: str) -> bool:
    text = clean_text(value)
    if not text:
        return False
    has_separator = re.search(r"(?:、|，|,|\s+\+\s+|\s+×\s+)", text)
    has_channel_marker = re.search(r"(?:ch\.?|channel|ちゃんねる|チャンネル)", text, re.IGNORECASE)
    return bool(has_separator and has_channel_marker)


def handle_from_channel_url(value) -> str:
    text = clean_text(value)
    marker = "youtube.com/@"
    lower = text.lower()
    index = lower.find(marker)
    if index < 0:
        return ""
    handle = text[index + len("youtube.com/") :].split("?", 1)[0].split("#", 1)[0].strip("/")
    return handle


def hydrate_payload_channel_metadata(payload: dict, metadata_path: Path) -> dict:
    metadata = load_channel_metadata(metadata_path)
    if not metadata:
        return payload
    groups = payload.get("groups") if isinstance(payload.get("groups"), dict) else {}
    hydrated_groups = {}
    for group_id, group in groups.items():
        if not isinstance(group, dict):
            hydrated_groups[group_id] = group
            continue
        items = group.get("items") if isinstance(group.get("items"), list) else []
        hydrated_groups[group_id] = {
            **group,
            "items": [hydrate_item_channel_metadata(item, metadata) if isinstance(item, dict) else item for item in items],
        }
    return {
        **payload,
        "groups": hydrated_groups,
        "source": {
            **(payload.get("source") if isinstance(payload.get("source"), dict) else {}),
            "channelMetadataCache": {
                "path": str(metadata_path.relative_to(ROOT)).replace("\\", "/") if metadata_path.is_relative_to(ROOT) else str(metadata_path),
                "channelCount": len(metadata),
            },
        },
    }


def load_channel_metadata(metadata_path: Path) -> dict[str, dict]:
    if not metadata_path.exists():
        return {}
    payload = read_json(metadata_path)
    channels = payload.get("channels") if isinstance(payload.get("channels"), list) else []
    lookup: dict[str, dict] = {}
    for channel in channels:
        if not isinstance(channel, dict):
            continue
        normalized = normalize_channel_metadata(channel)
        for key in channel_identity_keys(normalized):
            existing = lookup.get(key)
            lookup[key] = merge_channel_metadata(existing, normalized)
    return lookup


def hydrate_item_channel_metadata(item: dict, lookup: dict[str, dict]) -> dict:
    metadata = find_channel_metadata(lookup, normalize_channel_metadata(item))
    thumbnail_url = clean_text(item.get("thumbnailUrl") or item.get("thumbnail")) or thumbnail_url_for_video(item)
    if not metadata:
        return {**item, "thumbnailUrl": thumbnail_url}
    return {
        **item,
        "channelName": clean_text(item.get("channelName")) or metadata.get("displayName", ""),
        "channelId": clean_text(item.get("channelId")) or metadata.get("channelId", ""),
        "channelHandle": clean_text(item.get("channelHandle")) or metadata.get("channelHandle", ""),
        "channelUrl": clean_text(item.get("channelUrl") or item.get("authorUrl") or item.get("ownerUrl")) or metadata.get("channelUrl", "") or metadata.get("sourceUrl", ""),
        "avatarUrl": real_avatar_url(item.get("avatarUrl") or item.get("channelAvatarUrl")) or metadata.get("avatarUrl", ""),
        "sourceUrl": clean_text(item.get("sourceUrl")) or metadata.get("sourceUrl", "") or metadata.get("channelUrl", ""),
        "knownSourceType": clean_text(item.get("knownSourceType")) or metadata.get("knownSourceType", ""),
        "thumbnailUrl": thumbnail_url or metadata.get("thumbnailUrl", ""),
    }


def normalize_channel_metadata(value: dict) -> dict:
    channel_id = clean_text(value.get("channelId"))
    channel_handle = normalize_channel_handle(value.get("handle") or value.get("channelHandle") or value.get("sourceUrl") or value.get("channelUrl"))
    channel_url = clean_text(value.get("channelUrl") or value.get("authorUrl") or value.get("ownerUrl"))
    if not channel_url and channel_id:
        channel_url = f"https://www.youtube.com/channel/{channel_id}"
    source_url = clean_text(value.get("sourceUrl") or channel_url)
    if not source_url and channel_handle:
        source_url = f"https://www.youtube.com/{channel_handle}"
    return {
        "displayName": clean_text(value.get("displayName") or value.get("channelName") or value.get("name")),
        "channelId": channel_id,
        "channelHandle": channel_handle,
        "channelUrl": channel_url,
        "sourceUrl": source_url,
        "avatarUrl": real_avatar_url(value.get("avatarUrl") or value.get("channelAvatarUrl")),
        "thumbnailUrl": image_url(value.get("thumbnailUrl") or value.get("videoThumbnailUrl") or value.get("thumbnail")) or thumbnail_url_for_video(value),
        "knownSourceType": clean_text(value.get("knownSourceType")),
    }


def find_channel_metadata(lookup: dict[str, dict], metadata: dict) -> dict | None:
    for key in channel_identity_keys(metadata):
        if key in lookup:
            return lookup[key]
    return None


def merge_channel_metadata(existing: dict | None, incoming: dict) -> dict:
    if not existing:
        return incoming
    return {
        "displayName": existing.get("displayName") or incoming.get("displayName", ""),
        "channelId": existing.get("channelId") or incoming.get("channelId", ""),
        "channelHandle": existing.get("channelHandle") or incoming.get("channelHandle", ""),
        "channelUrl": existing.get("channelUrl") or incoming.get("channelUrl", ""),
        "sourceUrl": existing.get("sourceUrl") or incoming.get("sourceUrl", ""),
        "avatarUrl": existing.get("avatarUrl") or incoming.get("avatarUrl", ""),
        "thumbnailUrl": existing.get("thumbnailUrl") or incoming.get("thumbnailUrl", ""),
        "knownSourceType": existing.get("knownSourceType") or incoming.get("knownSourceType", ""),
    }


def channel_identity_keys(metadata: dict) -> list[str]:
    keys = [
        f"id:{metadata.get('channelId')}" if metadata.get("channelId") else "",
        f"handle:{normalize_key(metadata.get('channelHandle'))}" if metadata.get("channelHandle") else "",
        f"url:{normalize_channel_url_key(metadata.get('sourceUrl'))}" if metadata.get("sourceUrl") else "",
        f"url:{normalize_channel_url_key(metadata.get('channelUrl'))}" if metadata.get("channelUrl") else "",
        f"name:{normalize_key(metadata.get('displayName'))}" if metadata.get("displayName") else "",
    ]
    return [key for index, key in enumerate(keys) if key and key not in keys[:index]]


def normalize_channel_handle(value) -> str:
    text = clean_text(value)
    if not text:
        return ""
    marker = "youtube.com/@"
    lower = text.lower()
    if marker in lower:
        handle = text[lower.find(marker) + len("youtube.com/") :].split("?", 1)[0].split("#", 1)[0].strip("/")
        return f"/{handle}" if handle.startswith("@") else ""
    if text.startswith("/@"):
        return text
    if text.startswith("@"):
        return f"/{text}"
    return ""


def normalize_channel_url_key(value) -> str:
    text = clean_text(value).replace("http://www.", "https://www.").replace("http://", "https://")
    handle = normalize_channel_handle(text)
    if handle:
        return normalize_key(handle)
    marker = "youtube.com/channel/"
    lower = text.lower()
    if marker in lower:
        return f"channel/{text[lower.find(marker) + len(marker):].split('?', 1)[0].split('#', 1)[0].strip('/')}".lower()
    return normalize_key(text)


def thumbnail_url_for_video(item: dict) -> str:
    video_id = clean_text(item.get("videoId"))
    if len(video_id) == 11 and all(char.isalnum() or char in "_-" for char in video_id):
        return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    return ""


def image_url(value) -> str:
    text = clean_text(value)
    if text.startswith("http://") or text.startswith("https://"):
        return text
    return ""


def real_avatar_url(value) -> str:
    text = clean_text(value)
    if text.startswith("https://yt3.googleusercontent.com/") or (text.startswith("https://yt") and ".ggpht.com/" in text):
        return text
    if text.startswith("https://example.test/"):
        return text
    return ""


def stable_key(*parts) -> str:
    text = "\0".join(clean_text(part) for part in parts)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]


def search_text(*parts) -> str:
    return " ".join(filter(None, (normalize_key(part) for part in parts)))


def is_unknown_artist(value) -> bool:
    return normalize_key(value) in UNKNOWN_ARTISTS


def clean_text(value) -> str:
    return " ".join(str(value if value is not None else "").split()).strip()


def normalize_key(value) -> str:
    return unicodedata.normalize("NFKC", clean_text(value)).lower()


def int_or_none(value) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def read_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def dumps_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    sys.exit(main())
