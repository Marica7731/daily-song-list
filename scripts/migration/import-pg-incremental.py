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
import unicodedata
from typing import Any

import psycopg


LEGACY_IDENTITY_RESET_KIND = "legacy-vtuber-full-identity-reset"


def text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def normalized(value: Any) -> str:
    return " ".join(unicodedata.normalize("NFKC", text(value)).casefold().split())


def derived_song_key(title: Any, artist: Any) -> str:
    return hashlib.sha256(f"song\0{normalized(title)}\0{normalized(artist)}".encode("utf-8")).hexdigest()[:24]


def json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    return {}


def canonical_sha256(value: Any) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def lowercase_hex(value: Any, length: int) -> bool:
    candidate = text(value)
    return len(candidate) == length and all(
        character in "0123456789abcdef" for character in candidate
    )


def active_id(cur) -> str:
    cur.execute("SELECT state_value FROM migration_state WHERE state_key='active_revision_id'")
    row = cur.fetchone()
    return text(row[0]) if row else ""


def identity_reset_expectations(
    conn: Any,
    manifest: dict[str, Any],
    expected_active: str,
) -> dict[str, dict[str, str]]:
    """Recompute complete parent sets before creating the draft revision."""

    resets = manifest.get("identityResets")
    if resets in (None, []):
        return {}
    if not isinstance(resets, list):
        raise ValueError("identityResets must be an array")
    try:
        from legacy_vtuber_identity_reset import (
            ContractError,
            verify_reset_manifests_against_db,
        )
    except ImportError as exc:
        raise RuntimeError(
            "identity reset verifier is missing beside import-pg-incremental.py",
        ) from exc
    try:
        verified = verify_reset_manifests_against_db(
            conn, resets, expected_active,
        )
    except ContractError as exc:
        raise RuntimeError(f"identity reset parent CAS failed: {exc}") from exc
    expected = verified.get("expectedVideos")
    if not isinstance(expected, dict) or not expected:
        raise RuntimeError("identity reset verifier returned no expected videos")
    return {
        text(video_id): {
            "legacyDetailKey": text(value.get("legacyDetailKey")),
            "channelId": text(value.get("channelId")),
            "channelHandle": text(value.get("channelHandle")),
            "channelUrl": text(value.get("channelUrl")),
        }
        for video_id, value in expected.items()
        if isinstance(value, dict) and text(video_id)
    }


def has_legacy_identity_reset_marker(record: Any) -> bool:
    if not isinstance(record, dict):
        return False
    return (
        text(record.get("reason")) == LEGACY_IDENTITY_RESET_KIND
        or text(record.get("curationReason")) == LEGACY_IDENTITY_RESET_KIND
        or "identityResetEvidence" in record
        or "identityReset" in record
    )


def require_identity_reset_expectations(
    record: dict[str, Any],
    expected: dict[str, dict[str, str]],
) -> None:
    if has_legacy_identity_reset_marker(record) and not expected:
        raise ValueError(
            "legacy-marked accepted video requires non-empty identityResets",
        )


def verify_identity_reset_record(
    record: dict[str, Any],
    expected: dict[str, dict[str, str]],
    seen: set[str],
) -> None:
    video_id = text(record.get("videoId") or record.get("video_id"))
    contract = expected.get(video_id)
    if contract is None:
        raise ValueError(f"identity reset patch contains unexpected video={video_id}")
    if video_id in seen:
        raise ValueError(f"identity reset patch repeats video={video_id}")
    seen.add(video_id)
    handle = text(record.get("channelHandle") or record.get("channel_handle"))
    if handle.startswith("/"):
        handle = handle[1:]
    if (
        text(record.get("channelId") or record.get("channel_id"))
        != contract["channelId"]
        or handle != contract["channelHandle"]
        or text(record.get("channelUrl") or record.get("channel_url"))
        != contract["channelUrl"]
    ):
        raise ValueError(
            f"identity reset patch channel identity mismatch video={video_id}",
        )
    evidence = record.get("identityResetEvidence")
    if (
        text(record.get("reason")) != "legacy-vtuber-full-identity-reset"
        or not isinstance(evidence, dict)
        or text(evidence.get("videoId")) != video_id
    ):
        raise ValueError(f"identity reset patch misses review evidence video={video_id}")


def verify_identity_reset_patch(
    manifest: dict[str, Any],
    records: list[dict[str, Any]],
) -> dict[str, Any]:
    resets = manifest.get("identityResets")
    if not isinstance(resets, list) or not resets:
        raise ValueError("identity reset patch manifest is missing resets")
    try:
        from legacy_vtuber_identity_reset import (
            ContractError,
            validate_accepted_identity_resets,
        )
        return validate_accepted_identity_resets(resets, records)
    except ContractError as exc:
        raise ValueError(f"identity reset accepted patch failed: {exc}") from exc


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
        title = item.get("title")
        artist = item.get("artist")
        range_id = first_present(item, "rangeId", "range_id")
        if range_id is None:
            range_id = first_present(record, "rangeId", "range_id")
        if range_id is None:
            raise ValueError("occurrence rangeId is missing")
        song_key = first_present(item, "songKey", "song_key")
        if song_key is None:
            song_key = derived_song_key(title, artist)
        source_system = first_present(item, "sourceSystem", "source_system")
        if source_system is None:
            source_system = first_present(record, "sourceSystem", "source_system")
        if source_system is None:
            source_system = "mygit-7d"
        payload.update({"rangeId": range_id, "songKey": song_key, "sourceSystem": source_system})
        rows.append((
            video_id,
            occurrence_key,
            occurrence_id,
            int(item.get("position", position)),
            range_id,
            song_key,
            item.get("seconds"),
            item.get("title"),
            item.get("artist"),
            item.get("sourceId", item.get("source_id")),
            item.get("rawHash", item.get("raw_hash")),
            source_system,
            json.dumps(payload, ensure_ascii=False),
        ))
    return rows


def first_present(mapping: dict[str, Any], *keys: str) -> Any:
    """Return the first existing key, preserving explicit empty/NULL values."""

    for key in keys:
        if key in mapping:
            return mapping[key]
    return None



def authoritative_7d_manifest(manifest: dict[str, Any]) -> bool:
    return manifest.get("handoffKind") == "github-core-7d-authoritative-range"


def validate_authoritative_7d_manifest(manifest: dict[str, Any]) -> None:
    if not authoritative_7d_manifest(manifest):
        return
    positive = (
        "mutation_count", "acceptedVideoCount", "acceptedOccurrenceCount",
        "baseVideoCount", "baseOccurrenceCount", "rangeBoundaryMutationCount",
    )
    if not (
        manifest.get("status") == "ready"
        and manifest.get("rangeId") == "7d"
        and manifest.get("authoritativeRange") == "7d"
        and manifest.get("rangeReset") is True
        and manifest.get("partialVideoRows") is True
        and manifest.get("rangeResetAppliedBy") == "pg-adapter-authoritative-range-boundary-v2"
        and manifest.get("rangeResetTombstoneCount") == 0
        and manifest.get("sourceReachedEnd") is True
        and manifest.get("mediaDownloaded") is False
        and manifest.get("statusAuditIncluded") is True
        and all(isinstance(manifest.get(key), int) and manifest[key] > 0 for key in positive)
        and lowercase_hex(manifest.get("patch_sha256"), 64)
        and lowercase_hex(manifest.get("sourceBlobSha"), 40)
        and manifest.get("sourceBlobSha") == manifest.get("source_blob_sha")
        and lowercase_hex(manifest.get("sourceArtifactSha256"), 64)
        and lowercase_hex(manifest.get("sourceOccurrenceSemanticsSha256"), 64)
        and lowercase_hex(manifest.get("sourceManifestSha256"), 64)
    ):
        raise ValueError("authoritative 7d manifest contract is incomplete")
    expected = (
        manifest["rangeBoundaryMutationCount"]
        + manifest["acceptedVideoCount"]
        + manifest["acceptedOccurrenceCount"]
    )
    if manifest["mutation_count"] != expected:
        raise ValueError("authoritative 7d mutation_count mismatch")
    source_manifest = manifest.get("sourceManifest")
    expected_source_manifest = {
        "schemaVersion": 1,
        "path": "data/7d.json",
        "rangeId": "7d",
        "sourceCommitSha": manifest.get("sourceCommitSha"),
        "sourceBlobSha": manifest.get("sourceBlobSha"),
        "sourceArtifactSha256": manifest.get("sourceArtifactSha256"),
        "generatedAt": manifest.get("generatedAt"),
        "acceptedVideoCount": manifest.get("acceptedVideoCount"),
        "acceptedOccurrenceCount": manifest.get("acceptedOccurrenceCount"),
        "sourceOccurrenceSemanticsSha256": manifest.get(
            "sourceOccurrenceSemanticsSha256"
        ),
    }
    if source_manifest != expected_source_manifest:
        raise ValueError("authoritative 7d source manifest fields mismatch")
    if canonical_sha256(source_manifest) != manifest["sourceManifestSha256"]:
        raise ValueError("authoritative 7d source manifest SHA-256 mismatch")


def validate_authoritative_7d_record(record: dict[str, Any], manifest: dict[str, Any]) -> str:
    if not authoritative_7d_manifest(manifest):
        return "legacy"
    if record.get("kind") == "runtime" or record.get("entityType"):
        raise ValueError("authoritative 7d boundary cannot mix runtime rows")
    songs = record.get("songs")
    if not (
        record.get("partialRangeReset") is True
        and record.get("rangeId") == "7d"
        and isinstance(songs, list) and songs
        and all(isinstance(song, dict) and song.get("rangeId") == "7d" for song in songs)
        and record.get("sourceCommitSha") == manifest.get("sourceCommitSha")
        and record.get("sourceBlobSha") == manifest.get("sourceBlobSha")
        and record.get("sourceArtifactSha256") == manifest.get("sourceArtifactSha256")
    ):
        raise ValueError("authoritative 7d video contract is invalid")
    return "video"


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


def insert_runtime_row(cur, revision_id: str, record: dict[str, Any]) -> str:
    """Insert a metadata/source runtime row without duplicating occurrences."""

    entity_type = text(record.get("entityType") or record.get("entity_type"))
    entity_key = first_present(record, "entityKey", "entity_key")
    if not entity_type or entity_key is None or text(entity_key) == "":
        raise ValueError("runtime record requires entityType and entityKey")
    payload = record.get("payload")
    if not isinstance(payload, dict):
        payload = dict(record)
    tombstone = record.get("tombstone") is True
    cur.execute(
        """INSERT INTO migration_runtime_rows
        (revision_id,entity_type,entity_key,source_system,range_id,source_id,occurrence_id,tombstone,payload_json)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
        ON CONFLICT (revision_id,entity_type,entity_key) DO UPDATE SET
        source_system=EXCLUDED.source_system,range_id=EXCLUDED.range_id,
        source_id=EXCLUDED.source_id,occurrence_id=EXCLUDED.occurrence_id,
        tombstone=EXCLUDED.tombstone,payload_json=EXCLUDED.payload_json""",
        (revision_id, entity_type, text(entity_key),
         first_present(record, "sourceSystem", "source_system"),
         first_present(record, "rangeId", "range_id"),
         first_present(record, "sourceId", "source_id"),
         first_present(record, "occurrenceId", "occurrence_id"),
         tombstone, json.dumps(payload, ensure_ascii=False)),
    )
    return entity_type


def finalize(conn, revision_id: str, parent: str, manifest: dict[str, Any], stream_hash: str, videos: int, occurrences: int, runtime_rows: int, activate: bool) -> dict[str, Any]:
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute("SELECT parent_revision_id,status FROM migration_revisions WHERE revision_id=%s FOR UPDATE", (revision_id,))
            row = cur.fetchone()
            if not row or row[1] != "draft":
                raise RuntimeError(f"candidate is not draft: {revision_id}")
            content = hashlib.sha256(json.dumps({"manifest": manifest, "streamSha256": stream_hash, "videos": videos, "occurrences": occurrences}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            merged = {**manifest, "runtimeProjection": True, "incrementalOverlay": True, "streamSha256": stream_hash, "acceptedVideoCount": videos, "acceptedOccurrenceCount": occurrences, "runtimeRowCount": runtime_rows}
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
            return {"revisionId": revision_id, "parentRevisionId": parent, "videoCount": videos, "occurrenceCount": occurrences, "runtimeRowCount": runtime_rows, "contentSha256": content, "activated": activate}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision", required=True)
    parser.add_argument("--manifest-file", type=Path, required=True)
    parser.add_argument("--activate", action="store_true")
    args = parser.parse_args()
    manifest = json.loads(args.manifest_file.read_text(encoding="utf-8"))
    print("PG_AUTHORITATIVE_7D_MANIFEST_VALIDATION_OBSERVATION_ONLY", file=sys.stderr)
    generated_at = datetime.now(timezone.utc).isoformat()
    conn = psycopg.connect("dbname=song_rank")
    digest = hashlib.sha256()
    counts: defaultdict[str, int] = defaultdict(int)
    try:
        with conn.transaction():
            with conn.cursor() as cur:
                parent = active_id(cur)
        reset_expectations = identity_reset_expectations(conn, manifest, parent)
        reset_seen: set[str] = set()
        reset_records: list[dict[str, Any]] = []
        with conn.transaction():
            with conn.cursor() as cur:
                current = active_id(cur)
                if current != parent:
                    raise RuntimeError(
                        f"candidate parent changed during identity reset verification "
                        f"expected={parent} actual={current}",
                    )
                cur.execute("INSERT INTO migration_revisions (revision_id,parent_revision_id,status,source_manifest_sha256,manifest_json) VALUES (%s,NULLIF(%s,''),'draft',%s,%s::jsonb)", (args.revision, parent, text(manifest.get("sourceManifestSha256")), json.dumps(manifest, ensure_ascii=False)))
        for raw in sys.stdin.buffer:
            if not raw.strip():
                continue
            digest.update(raw)
            record = json.loads(raw)
            if not isinstance(record, dict):
                raise ValueError("accepted increment line must be an object")
            validate_authoritative_7d_record(record, manifest)
            require_identity_reset_expectations(record, reset_expectations)
            if reset_expectations:
                if record.get("kind") == "runtime" or record.get("entityType") or record.get("entity_type"):
                    raise ValueError(
                        "identity reset patch cannot mix runtime metadata rows",
                    )
                verify_identity_reset_record(
                    record, reset_expectations, reset_seen,
                )
                reset_records.append(record)
            with conn.transaction():
                with conn.cursor() as cur:
                    if record.get("kind") == "runtime" or record.get("entityType") or record.get("entity_type"):
                        insert_runtime_row(cur, args.revision, record)
                        counts["runtimeRows"] += 1
                    else:
                        video_id, occurrence_count = insert_video(cur, args.revision, record, generated_at)
                        counts["videos"] += 1
                        counts["occurrences"] += occurrence_count
            if counts["videos"] % 100 == 0:
                print(f"PG_INCREMENT_PROGRESS videos={counts['videos']} occurrences={counts['occurrences']}", file=sys.stderr, flush=True)
        if reset_expectations and reset_seen != set(reset_expectations):
            missing = sorted(set(reset_expectations) - reset_seen)
            raise ValueError(
                f"identity reset patch is partial missing={','.join(missing[:8])}",
            )
        if reset_expectations:
            verified_patch = verify_identity_reset_patch(manifest, reset_records)
            if (
                verified_patch["videoCount"] != len(reset_expectations)
                or verified_patch["occurrenceCount"]
                != int(manifest.get("acceptedOccurrenceCount") or 0)
                or verified_patch != {
                    "videoCount": 415,
                    "occurrenceCount": 5613,
                    "identityResetCount": 4,
                }
            ):
                raise ValueError(
                    "identity reset patch totals disagree with manifest",
                )
        if authoritative_7d_manifest(manifest):
            if counts["videos"] != manifest["acceptedVideoCount"]:
                raise ValueError("authoritative 7d video count mismatch")
            if counts["occurrences"] != manifest["acceptedOccurrenceCount"]:
                raise ValueError("authoritative 7d occurrence count mismatch")
            if counts["runtimeRows"] != 0:
                raise ValueError("authoritative 7d boundary cannot contain runtime rows")
        result = finalize(
            conn, args.revision, parent, manifest, digest.hexdigest(),
            counts["videos"], counts["occurrences"], counts["runtimeRows"], args.activate,
        )
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

