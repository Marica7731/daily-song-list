#!/usr/bin/env python3
"""Import framed runtime-table NDJSON into a PostgreSQL candidate.

This runs on the PostgreSQL host only as a bounded receiver.  The Mac
runner owns the SQLite read and the stream; the receiver never stores SQLite,
raw HTML, or a second full candidate.  Each table COPY commits independently
inside one draft revision, and only the final locked activation can become
active.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import sys
from typing import Any

import psycopg


TABLES: dict[str, tuple[str, ...]] = {
    "meta": ("key", "value"),
    "videos": ("video_id", "title", "channel_name", "channel_id", "channel_handle", "channel_url", "keyword", "published_timestamp", "published_text", "duration_text", "thumbnail_url", "payload_json"),
    "occurrences": ("occurrence_id", "range_id", "video_id", "song_key", "seconds", "source_system", "source_id", "title", "artist", "is_niche", "is_unknown_artist", "payload_json"),
    "songs": ("song_key", "title", "artist", "is_niche", "payload_json"),
    "ranking_rows": ("row_id", "range_id", "view", "metric", "scope_key", "rank", "detail_key", "title", "artist", "name", "count", "song_count", "video_count", "timestamp_count", "payload_json", "search_text", "channel_search_text"),
    "source_details": ("source_key", "range_id", "entity_type", "entity_key", "payload_json"),
    "source_occurrences": ("source_key", "range_id", "position", "video_id", "title", "channel_name", "channel_id", "channel_handle", "channel_url", "published_timestamp", "seconds", "is_niche", "is_unknown_artist", "search_text", "payload_json"),
    "channel_metadata": ("channel_key", "channel_id", "handle", "display_name", "avatar_url", "thumbnail_url", "source_url", "channel_url", "known_source_type", "is_collected", "payload_json"),
    "external_songs": ("source_system", "external_song_id", "canonical_song_id", "title", "artist", "source_url", "payload_json"),
    "external_videos": ("source_system", "external_video_id", "youtube_video_id", "title", "singer_name", "streamed_at", "source_url", "payload_json"),
    "external_occurrences": ("source_system", "occurrence_id", "canonical_song_id", "external_song_id", "external_video_id", "youtube_video_id", "seconds", "payload_json"),
}

# SQLite calls the ranking aggregate ``count``; the PostgreSQL projection
# names the same value ``row_count``. The wire row order stays unchanged.
TARGET_COLUMNS: dict[str, tuple[str, ...]] = {
    **TABLES,
    "ranking_rows": ("row_id", "range_id", "view", "metric", "scope_key", "rank", "detail_key", "title", "artist", "name", "row_count", "song_count", "video_count", "timestamp_count", "payload_json", "search_text", "channel_search_text"),
}


def qident(value: str) -> str:
    valid_tables = {f"runtime_{name}" for name in TABLES}
    valid_columns = {column for columns in TARGET_COLUMNS.values() for column in columns} | {"revision_id"}
    if value not in valid_tables and value not in valid_columns:
        raise ValueError(f"unexpected identifier: {value}")
    return '"' + value.replace('"', '""') + '"'


def active_id(cur) -> str:
    cur.execute("SELECT state_value FROM migration_state WHERE state_key = 'active_revision_id'")
    row = cur.fetchone()
    return str(row[0] or "") if row else ""


def create_revision(conn, revision_id: str, manifest: dict[str, Any]) -> str:
    with conn.cursor() as cur:
        parent = active_id(cur)
        cur.execute(
            "INSERT INTO migration_revisions (revision_id,parent_revision_id,status,source_manifest_sha256,manifest_json) VALUES (%s,NULLIF(%s,''),'draft',%s,%s::jsonb)",
            (revision_id, parent, str(manifest.get("sourceManifestSha256", "")), json.dumps(manifest, ensure_ascii=False)),
        )
    conn.commit()
    return parent


def copy_table(conn, name: str, columns: tuple[str, ...], revision_id: str, rows: list[list[Any]]) -> int:
    table = f"runtime_{name}"
    with conn.cursor() as cur:
        target_columns = TARGET_COLUMNS[name]
        statement = f"COPY {qident(table)} ({', '.join(qident(column) for column in target_columns)}, revision_id) FROM STDIN"
        with cur.copy(statement) as copy:
            for values in rows:
                copy.write_row(values + [revision_id])
    conn.commit()
    return len(rows)


def finalize(conn, revision_id: str, stream_sha256: str, counts: dict[str, int], manifest: dict[str, Any], activate: bool) -> dict[str, Any]:
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute("SELECT parent_revision_id,status FROM migration_revisions WHERE revision_id=%s FOR UPDATE", (revision_id,))
            row = cur.fetchone()
            if not row or row[1] != "draft":
                raise RuntimeError(f"candidate is not draft: {revision_id}")
            cur.execute("SELECT count(*) FROM runtime_videos WHERE revision_id=%s", (revision_id,))
            video_count = int(cur.fetchone()[0])
            cur.execute("SELECT count(*) FROM runtime_occurrences WHERE revision_id=%s", (revision_id,))
            occurrence_count = int(cur.fetchone()[0])
            content = hashlib.sha256(json.dumps({"counts": counts, "streamSha256": stream_sha256}, sort_keys=True).encode()).hexdigest()
            merged = {**manifest, "runtimeProjection": True, "streamSha256": stream_sha256, "tableCounts": counts}
            cur.execute("UPDATE migration_revisions SET status='ready', manifest_json=%s::jsonb, content_sha256=%s, video_count=%s, occurrence_count=%s WHERE revision_id=%s", (json.dumps(merged, ensure_ascii=False), content, video_count, occurrence_count, revision_id))
            if activate:
                cur.execute("SELECT state_value FROM migration_state WHERE state_key='active_revision_id' FOR UPDATE")
                current = str((cur.fetchone() or [""])[0] or "")
                if str(row[0] or "") != current:
                    raise RuntimeError(f"candidate parent mismatch candidate={row[0] or '<none>'} active={current or '<none>'}")
                if current:
                    cur.execute("UPDATE migration_revisions SET status='superseded' WHERE revision_id=%s AND status='active'", (current,))
                cur.execute("UPDATE migration_revisions SET status='active',activated_at=CURRENT_TIMESTAMP WHERE revision_id=%s", (revision_id,))
                cur.execute("UPDATE migration_state SET state_value=%s WHERE state_key='active_revision_id'", (revision_id,))
            return {"revisionId": revision_id, "parentRevisionId": row[0], "videoCount": video_count, "occurrenceCount": occurrence_count, "contentSha256": content, "activated": activate}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision", required=True)
    parser.add_argument("--manifest-json", default="{}")
    parser.add_argument("--manifest-file", type=Path)
    parser.add_argument("--activate", action="store_true")
    args = parser.parse_args()
    manifest = json.loads(args.manifest_file.read_text(encoding="utf-8")) if args.manifest_file else json.loads(args.manifest_json)
    conn = psycopg.connect("dbname=song_rank")
    counts: dict[str, int] = defaultdict(int)
    digest = hashlib.sha256()
    current_name: str | None = None
    current_columns: tuple[str, ...] | None = None
    current_rows: list[list[Any]] = []
    try:
        parent = create_revision(conn, args.revision, manifest)
        for raw in sys.stdin.buffer:
            digest.update(raw)
            message = json.loads(raw)
            if isinstance(message, list):
                if current_name is None:
                    raise RuntimeError("row frame outside table")
                current_rows.append(message)
                if len(current_rows) >= 2000:
                    counts[current_name] += copy_table(conn, current_name, current_columns, args.revision, current_rows)
                    current_rows = []
                continue
            kind = message.get("type")
            if kind == "table":
                if current_name is not None:
                    raise RuntimeError(f"table {current_name} missing end frame")
                current_name = str(message["name"])
                current_columns = tuple(message["columns"])
                if current_name not in TABLES or current_columns != TABLES[current_name]:
                    raise RuntimeError(f"unexpected table schema: {current_name}")
                current_rows = []
            elif kind == "end":
                if current_name != message.get("name") or current_columns is None:
                    raise RuntimeError("invalid end frame")
                counts[current_name] += copy_table(conn, current_name, current_columns, args.revision, current_rows)
                current_name = None
                current_columns = None
                current_rows = []
            elif kind == "stream_end":
                break
            else:
                raise RuntimeError("invalid stream frame")
        if current_name is not None:
            raise RuntimeError(f"stream ended inside table {current_name}")
        result = finalize(conn, args.revision, digest.hexdigest(), dict(counts), manifest, args.activate)
        print(json.dumps({"status": "ok", **result}, ensure_ascii=False))
        return 0
    except Exception as exc:
        conn.rollback()
        print(f"RUNTIME_IMPORT_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
