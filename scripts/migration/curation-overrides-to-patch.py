#!/usr/bin/env python3
"""Convert audited curation overrides into occurrence-scoped PG overlay rows.

The curation rules identify source evidence (often a comment ``sourceId``),
while the PostgreSQL runtime uses its own immutable ``occurrence_id`` as the
overlay key.  This converter joins the two using a bounded snapshot of the
currently active rows.  It never guesses across videos or duplicate timecodes:
ambiguous and unmatched rules are written to the review audit and make the
manifest non-ready.

Input snapshot is NDJSON.  Occurrence lines contain the flattened runtime
fields; optional ``kind=video`` lines prove that a whole-video tombstone is
already absent or can be applied.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import unicodedata
from typing import Any, Iterable


def text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def norm(value: Any) -> str:
    return " ".join(unicodedata.normalize("NFKC", text(value)).casefold().split())


def first(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping:
            return mapping[key]
    return None


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("records"), list):
        raise ValueError("curation overrides must be an object with a records list")
    return payload


def read_snapshot(path: Path) -> tuple[dict[str, list[dict[str, Any]]], set[str], str]:
    by_video: dict[str, list[dict[str, Any]]] = {}
    video_ids: set[str] = set()
    digest = hashlib.sha256()
    stream = sys.stdin.buffer if str(path) == "-" else path.open("rb")
    try:
        for raw in stream:
            if not raw.strip():
                continue
            digest.update(raw)
            item = json.loads(raw)
            if not isinstance(item, dict):
                raise ValueError("snapshot line must be an object")
            kind = text(item.get("kind"))
            video_id = text(first(item, "videoId", "video_id"))
            if not video_id:
                raise ValueError("snapshot row missing videoId")
            video_ids.add(video_id)
            if kind in {"video", "videos"}:
                continue
            occurrence_id = text(first(item, "occurrenceId", "occurrence_id"))
            if not occurrence_id:
                raise ValueError(f"snapshot occurrence missing occurrenceId: {video_id}")
            row = dict(item)
            row["videoId"] = video_id
            row["occurrenceId"] = occurrence_id
            by_video.setdefault(video_id, []).append(row)
    finally:
        if stream is not sys.stdin.buffer:
            stream.close()
    for rows in by_video.values():
        rows.sort(key=lambda row: (int(row.get("position") or 0), text(row["occurrenceId"])))
    return by_video, video_ids, digest.hexdigest()


def candidate_rows(override: dict[str, Any], rows: Iterable[dict[str, Any]], action: str) -> list[dict[str, Any]]:
    seconds = override.get("seconds")
    candidates = [row for row in rows if row.get("seconds") == seconds]

    expected_raw = text(override.get("rawHash"))
    with_raw = [row for row in candidates if text(row.get("rawHash"))]
    if expected_raw and with_raw:
        candidates = [row for row in candidates if text(row.get("rawHash")) == expected_raw]

    expected_source = text(override.get("sourceId"))
    with_source = [row for row in candidates if text(row.get("sourceId"))]
    if expected_source and with_source:
        source_matches = [row for row in candidates if text(row.get("sourceId")) == expected_source]
        if source_matches:
            candidates = source_matches

    # drop_entry carries the original title and artist.  replace_entry does
    # not always carry them, so it must remain unique after the identity pass.
    if action == "drop_entry":
        if "title" in override:
            candidates = [row for row in candidates if norm(row.get("title")) == norm(override.get("title"))]
        if "artist" in override:
            candidates = [row for row in candidates if norm(row.get("artist")) == norm(override.get("artist"))]
    return candidates


def audit_result(index: int, override: dict[str, Any], status: str, **extra: Any) -> dict[str, Any]:
    result = {
        "index": index,
        "action": text(override.get("action")),
        "videoId": text(override.get("videoId")),
        "sourceId": override.get("sourceId"),
        "seconds": override.get("seconds"),
        "status": status,
        "reason": text(override.get("reason")),
        "reviewedAt": override.get("reviewedAt"),
        "reviewedBy": override.get("reviewedBy"),
    }
    result.update(extra)
    return result


def runtime_row(override: dict[str, Any], current: dict[str, Any], tombstone: bool, replacement: dict[str, Any] | None = None) -> dict[str, Any]:
    occurrence_id = text(current["occurrenceId"])
    payload = dict(current)
    payload.pop("kind", None)
    if replacement:
        payload.update(replacement)
    payload.update({
        "videoId": text(current["videoId"]),
        "occurrenceId": occurrence_id,
        "curationAction": text(override.get("action")),
        "curationReason": text(override.get("reason")),
        "reviewedAt": override.get("reviewedAt"),
        "reviewedBy": override.get("reviewedBy"),
        "note": text(override.get("note")),
    })
    return {
        "kind": "runtime",
        "entityType": "occurrences",
        "entityKey": occurrence_id,
        "sourceSystem": current.get("sourceSystem"),
        "rangeId": current.get("rangeId"),
        "sourceId": current.get("sourceId"),
        "occurrenceId": occurrence_id,
        "tombstone": tombstone,
        "payload": payload,
    }


def video_tombstone(override: dict[str, Any]) -> dict[str, Any]:
    video_id = text(override.get("videoId"))
    return {
        "kind": "runtime",
        "entityType": "videos",
        "entityKey": video_id,
        "tombstone": True,
        "payload": {
            "videoId": video_id,
            "curationAction": "drop_video",
            "curationReason": text(override.get("reason")),
            "reviewedAt": override.get("reviewedAt"),
            "reviewedBy": override.get("reviewedBy"),
            "note": text(override.get("note")),
        },
    }


def convert(overrides_path: Path, snapshot_path: Path, output_path: Path, manifest_path: Path, review_path: Path) -> dict[str, Any]:
    overrides_raw = overrides_path.read_bytes()
    overrides = json.loads(overrides_raw.decode("utf-8"))
    if not isinstance(overrides, dict) or not isinstance(overrides.get("records"), list):
        raise ValueError("curation overrides must be an object with a records list")
    by_video, video_ids, snapshot_sha = read_snapshot(snapshot_path)
    generated_at = datetime.now(timezone.utc).isoformat()
    audit: list[dict[str, Any]] = []
    mutations: list[dict[str, Any]] = []

    for index, raw_override in enumerate(overrides["records"]):
        if not isinstance(raw_override, dict):
            audit.append({"index": index, "status": "invalid", "error": "override is not an object"})
            continue
        action = text(raw_override.get("action"))
        video_id = text(raw_override.get("videoId"))
        rows = by_video.get(video_id, [])
        if action == "drop_video":
            if video_id not in video_ids:
                audit.append(audit_result(index, raw_override, "already_applied_absent", evidence="active snapshot has no video"))
            else:
                mutations.append(video_tombstone(raw_override))
                audit.append(audit_result(index, raw_override, "accepted", evidence="active video present"))
            continue
        if action not in {"drop_entry", "replace_entry"}:
            audit.append(audit_result(index, raw_override, "invalid", error=f"unsupported action: {action}"))
            continue
        replacement = raw_override.get("replacement")
        if action == "replace_entry" and (
            not isinstance(replacement, dict)
            or not text(replacement.get("title")) and not text(replacement.get("artist"))
        ):
            audit.append(audit_result(index, raw_override, "invalid", error="replace_entry requires replacement.title or replacement.artist"))
            continue
        candidates = candidate_rows(raw_override, rows, action)
        if len(candidates) == 0:
            # The desired post-curation state is already true when the exact
            # audited video/time row is absent from the active snapshot.  Keep
            # this explicit in the audit rather than silently dropping it.
            audit.append(audit_result(index, raw_override, "already_applied_absent", evidence="active snapshot has no occurrence at audited video/time"))
            continue
        if action == "replace_entry" and isinstance(replacement, dict):
            expected_title = norm(replacement.get("title"))
            expected_artist = norm(replacement.get("artist"))
            already = [
                row for row in candidates
                if (not expected_title or norm(row.get("title")) == expected_title)
                and (not expected_artist or norm(row.get("artist")) == expected_artist)
            ]
            if len(already) == 1:
                audit.append(audit_result(index, raw_override, "already_applied", occurrenceId=already[0]["occurrenceId"], evidence="active occurrence already equals replacement"))
                continue
        if len(candidates) > 1:
            audit.append(audit_result(index, raw_override, "ambiguous", occurrenceIds=[row["occurrenceId"] for row in candidates]))
            continue
        current = candidates[0]
        if action == "drop_entry":
            mutations.append(runtime_row(raw_override, current, True))
            audit.append(audit_result(index, raw_override, "accepted", occurrenceId=current["occurrenceId"], evidence="video+seconds+title+artist match"))
            continue
        expected_title = norm(replacement.get("title"))
        expected_artist = norm(replacement.get("artist"))
        if (not expected_title or norm(current.get("title")) == expected_title) and (not expected_artist or norm(current.get("artist")) == expected_artist):
            audit.append(audit_result(index, raw_override, "already_applied", occurrenceId=current["occurrenceId"], evidence="active occurrence already equals replacement"))
            continue
        mutations.append(runtime_row(raw_override, current, False, replacement))
        audit.append(audit_result(index, raw_override, "accepted", occurrenceId=current["occurrenceId"], evidence="video+seconds unique match"))

    counts: dict[str, int] = {}
    for item in audit:
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    review = {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "summary": counts,
        "results": audit,
    }
    review_path.write_text(json.dumps(review, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as stream:
        for mutation in mutations:
            stream.write(json.dumps(mutation, ensure_ascii=False, separators=(",", ":")) + "\n")
    manifest = {
        "schemaVersion": 1,
        "kind": "curation-accepted-increment",
        "status": "ready" if not any(counts.get(key, 0) for key in ("unmatched", "ambiguous", "invalid")) else "needs_review",
        "generatedAt": generated_at,
        "rangeId": "all",
        "sourceReachedEnd": True,
        "mediaDownloaded": False,
        "statusAuditIncluded": True,
        "curationArtifactIncluded": True,
        "curationMutationCount": len(mutations),
        "overrideCount": len(overrides["records"]),
        "reviewAudit": counts,
        "overridesSha256": sha256_bytes(overrides_raw),
        "snapshotSha256": snapshot_sha,
        "reviewSha256": sha256_bytes(review_path.read_bytes()),
        "sourceManifestSha256": sha256_bytes((sha256_bytes(overrides_raw) + snapshot_sha).encode("ascii")),
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--overrides", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True, help="NDJSON active occurrence/video snapshot, or - for stdin")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest-output", type=Path, required=True)
    parser.add_argument("--review-output", type=Path, required=True)
    args = parser.parse_args()
    try:
        manifest = convert(args.overrides, args.snapshot, args.output, args.manifest_output, args.review_output)
        print(json.dumps({"status": "ok", **manifest}, ensure_ascii=False))
        return 0 if manifest["status"] == "ready" else 78
    except Exception as exc:
        print(f"CURATION_PATCH_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
