#!/usr/bin/env python3
"""Receive a bounded accepted-increment NDJSON stream on VPS2.

The receiver writes only a revision-scoped overlay.  It never replaces the
active pointer; the workflow must run the candidate API gate and the locked
activation script separately.  The parent full runtime projection remains
available to the adapter while this revision is being compared.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
from typing import Any

import psycopg


def text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    return {}


def active_id(cur) -> str:
    cur.execute("SELECT state_value FROM migration_state WHERE state_key='active_revision_id'")
    row = cur.fetchone()
    return text(row[0]) if row else ""


def occurrence_rows(record: dict[str, Any], video_id: str) -> list[tuple[Any, ...]]:
    values = record.get("songs")
    if not isinstance(values, list):
        values = record.get("entries")
    if not isinstance(values, list):
        values = []
    rows: list[tuple[Any, ...]] = []
    seen: set[str] = set()
    for position, item in enumerate(values):
        if not isinstance(item, dict):
            continue
        occurrence_id = item.get("occurrenceId", item.get("occurrence_id"))
        occurrence_key = text(occurrence_id) or f"position:{position}"
        if occurrence_key in seen:
            raise ValueError(f"video {video_id} repeats occurrence identity={occurrence_key}")
        seen.add(occurrence_key)
        payload = dict(item)
        payload.setdefault("videoId", video_id)
        payload.setdefault("position", position)
        rows.append((
            video_id,
            occurrence_key,
            occurrence_id,
            int(item.get("position", position)),
            item.get("rangeId", item.get("range_id")),
            item.get("songKey", item.get("song_key")),
            item.get("seconds"),
            item.get("title"),
            item.get("artist"),
            item.get("sourceId", item.get("source_id")),
            item.get("rawHash", item.get("raw_hash")),
            item.get("sourceSystem", item.get("source_system")),
            json.dumps(payload, ensure_ascii=False),
        ))
    return rows


def insert_video(cur, revision_id: str, record: dict[str, Any], generated_at: str) -> tuple[str, int]:
    video_id = text(record.get("videoId", record.get("video_id")))
    if not video_id:
        raise ValueError("accepted increment video requires videoId")
    deleted = record.get("deleted") is True or record.get("tombstone") is True
    payload = dict(record)
    title = record.get("title")
    cur.execute(
        """INSERT INTO migration_video_rows
        (revision_id,video_id,title,channel_name,channel_id,channel_handle,channel_url,published_at,tombstone,payload_json)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
        ON CONFLICT (revision_id,video_id) DO UPDATE SET title=EXCLUDED.title,
        channel_name=EXCLUDED.channel_name,channel_id=EXCLUDED.channel_id,
        channel_handle=EXCLUDED.channel_handle,channel_url=EXCLUDED.channel_url,
        published_at=EXCLUDED.published_at,tombstone=EXCLUDED.tombstone,
        payload_json=EXCLUDED.payload_json""",
        (revision_id, video_id, title,
         record.get("channelName", record.get("channel_name")),
         record.get("channelId", record.get("channel_id")),
         record.get("channelHandle", record.get("channel_handle")),
         record.get("channelUrl", record.get("channel_url")),
         record.get("publishedAt", record.get("published_at")), deleted,
         json.dumps(payload, ensure_ascii=False)),
    )
    cur.execute("DELETE FROM migration_occurrence_rows WHERE revision_id=%s AND video_id=%s", (revision_id, video_id))
    rows = [] if deleted else occurrence_rows(record, video_id)
    if rows:
        with cur.copy("""COPY migration_occurrence_rows
          (revision_id,video_id,occurrence_key,occurrence_id,position,range_id,song_key,seconds,title,artist,source_id,raw_hash,source_system,payload_json)
          FROM STDIN""") as copy:
            for row in rows:
                copy.write_row((revision_id, *row))
    reason = text(record.get("curationReason") or record.get("reason") or "accepted-increment")
    reviewed_by = text(record.get("reviewedBy") or "curation-pipeline")
    reviewed_at = text(record.get("reviewedAt") or generated_at)
    note = text(record.get("note"))
    cur.execute(
        """INSERT INTO migration_audit_rows (revision_id,video_id,reason,reviewed_at,reviewed_by,note)
        VALUES (%s,%s,%s,%s,%s,%s)
        ON CONFLICT (revision_id,video_id) DO UPDATE SET reason=EXCLUDED.reason,
        reviewed_at=EXCLUDED.reviewed_at,reviewed_by=EXCLUDED.reviewed_by,note=EXCLUDED.note""",
        (revision_id, video_id, reason, reviewed_at, reviewed_by, note),
    )
    return video_id, len(rows)


def finalize(conn, revision_id: str, parent: str, manifest: dict[str, Any], stream_hash: str, videos: int, occurrences: int, activate: bool) -> dict[str, Any]:
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute("SELECT parent_revision_id,status FROM migration_revisions WHERE revision_id=%s FOR UPDATE", (revision_id,))
            row = cur.fetchone()
            if not row or row[1] != "draft":
                raise RuntimeError(f"candidate is not draft: {revision_id}")
            content = hashlib.sha256(json.dumps({"manifest": manifest, "streamSha256": stream_hash, "videos": videos, "occurrences": occurrences}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            merged = {**manifest, "runtimeProjection": True, "incrementalOverlay": True, "streamSha256": stream_hash, "acceptedVideoCount": videos, "acceptedOccurrenceCount": occurrences}
            cur.execute("UPDATE migration_revisions SET status='ready',manifest_json=%s::jsonb,content_sha256=%s,video_count=%s,occurrence_count=%s WHERE revision_id=%s", (json.dumps(merged, ensure_ascii=False), content, videos, occurrences, revision_id))
            if activate:
                cur.execute("SELECT state_value FROM migration_state WHERE state_key='active_revision_id' FOR UPDATE")
                current = text((cur.fetchone() or [""])[0])
                if text(row[0]) != current:
                    raise RuntimeError(f"candidate parent mismatch candidate={text(row[0]) or '<none>'} active={current or '<none>'}")
                if current:
                    cur.execute("UPDATE migration_revisions SET status='superseded' WHERE revision_id=%s AND status='active'", (current,))
                cur.execute("UPDATE migration_revisions SET status='active',activated_at=CURRENT_TIMESTAMP WHERE revision_id=%s", (revision_id,))
                cur.execute("UPDATE migration_state SET state_value=%s WHERE state_key='active_revision_id'", (revision_id,))
            return {"revisionId": revision_id, "parentRevisionId": parent, "videoCount": videos, "occurrenceCount": occurrences, "contentSha256": content, "activated": activate}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision", required=True)
    parser.add_argument("--manifest-file", type=Path, required=True)
    parser.add_argument("--activate", action="store_true")
    args = parser.parse_args()
    manifest = json.loads(args.manifest_file.read_text(encoding="utf-8"))
    generated_at = datetime.now(timezone.utc).isoformat()
    conn = psycopg.connect("dbname=song_rank")
    digest = hashlib.sha256()
    counts: defaultdict[str, int] = defaultdict(int)
    try:
        with conn.transaction():
            with conn.cursor() as cur:
                parent = active_id(cur)
                cur.execute("INSERT INTO migration_revisions (revision_id,parent_revision_id,status,source_manifest_sha256,manifest_json) VALUES (%s,NULLIF(%s,''),'draft',%s,%s::jsonb)", (args.revision, parent, text(manifest.get("sourceManifestSha256")), json.dumps(manifest, ensure_ascii=False)))
        for raw in sys.stdin.buffer:
            if not raw.strip():
                continue
            digest.update(raw)
            record = json.loads(raw)
            if not isinstance(record, dict):
                raise ValueError("accepted increment line must be an object")
            with conn.transaction():
                with conn.cursor() as cur:
                    video_id, occurrence_count = insert_video(cur, args.revision, record, generated_at)
            counts["videos"] += 1
            counts["occurrences"] += occurrence_count
            if counts["videos"] % 100 == 0:
                print(f"PG_INCREMENT_PROGRESS videos={counts['videos']} occurrences={counts['occurrences']}", file=sys.stderr, flush=True)
        result = finalize(conn, args.revision, parent, manifest, digest.hexdigest(), counts["videos"], counts["occurrences"], args.activate)
        print(json.dumps({"status": "ok", **result}, ensure_ascii=False))
        return 0
    except Exception as exc:
        conn.rollback()
        with conn.cursor() as cur:
            cur.execute("DELETE FROM migration_revisions WHERE revision_id=%s", (args.revision,))
        conn.commit()
        print(f"PG_INCREMENT_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
