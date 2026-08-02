#!/usr/bin/env python3
"""Atomically activate a ready PostgreSQL runtime candidate."""

from __future__ import annotations

import argparse
import json
import re

import psycopg


PROJECT_ACTIVE_LOCK = "daily-song-list/active"
SHA1 = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def text(value: object) -> str:
    return str(value or "").strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision", required=True)
    parser.add_argument("--expected-active-revision", required=True)
    parser.add_argument("--expected-parent-revision", required=True)
    parser.add_argument("--expected-content-sha256", required=True)
    parser.add_argument("--expected-source-blob-sha", default="")
    parser.add_argument("--expected-source-manifest-sha256", default="")
    args = parser.parse_args()
    if not SHA256.fullmatch(args.expected_content_sha256):
        parser.error("expected content SHA-256 must be lowercase 64-hex")
    if args.expected_source_blob_sha and not SHA1.fullmatch(args.expected_source_blob_sha):
        parser.error("expected source blob SHA must be lowercase 40-hex")
    if args.expected_source_manifest_sha256 and not SHA256.fullmatch(args.expected_source_manifest_sha256):
        parser.error("expected source manifest SHA-256 must be lowercase 64-hex")
    if bool(args.expected_source_blob_sha) != bool(args.expected_source_manifest_sha256):
        parser.error("source blob and source manifest CAS arguments must be paired")

    conn = psycopg.connect("dbname=song_rank")
    try:
        with conn.transaction():
            with conn.cursor() as cur:
                # This is the same transaction-scoped project lock used by
                # rollback.  The pointer, parent and candidate content checks
                # below therefore cannot race another release controller.
                cur.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s))",
                    (PROJECT_ACTIVE_LOCK,),
                )
                cur.execute(
                    "SELECT state_value FROM migration_state "
                    "WHERE state_key='active_revision_id' FOR UPDATE"
                )
                current = text((cur.fetchone() or [""])[0])
                cur.execute(
                    """SELECT revision_id,parent_revision_id,status,content_sha256,
                              source_manifest_sha256,manifest_json
                       FROM migration_revisions
                       WHERE revision_id=%s FOR UPDATE""",
                    (args.revision,),
                )
                row = cur.fetchone()
                if not row:
                    raise RuntimeError(f"candidate not found: {args.revision}")
                (
                    revision_id,
                    parent_id,
                    status,
                    content_sha256,
                    source_manifest_sha256,
                    manifest_json,
                ) = row
                manifest = manifest_json if isinstance(manifest_json, dict) else {}
                if status != "ready":
                    raise RuntimeError(
                        f"candidate not ready: {args.revision} status={status}"
                    )
                if current != args.expected_active_revision:
                    raise RuntimeError(
                        "captured active pointer CAS failed "
                        f"expected={args.expected_active_revision} actual={current or '<none>'}"
                    )
                if current != args.expected_parent_revision:
                    raise RuntimeError(
                        "expected parent is not the captured active revision "
                        f"expectedActive={args.expected_active_revision} "
                        f"expectedParent={args.expected_parent_revision}"
                    )
                if text(parent_id) != current:
                    raise RuntimeError(
                        "candidate parent CAS failed; candidate parent/current active CAS failed "
                        f"candidate={text(parent_id) or '<none>'} "
                        f"active={current or '<none>'}"
                    )
                if text(content_sha256) != args.expected_content_sha256:
                    raise RuntimeError("candidate content SHA-256 CAS failed")
                if args.expected_source_manifest_sha256:
                    if text(source_manifest_sha256) != args.expected_source_manifest_sha256:
                        raise RuntimeError("candidate source manifest SHA-256 CAS failed")
                    if text(manifest.get("sourceManifestSha256")) != args.expected_source_manifest_sha256:
                        raise RuntimeError("candidate manifest source hash disagrees with revision")
                    if text(manifest.get("sourceBlobSha") or manifest.get("source_blob_sha")) != args.expected_source_blob_sha:
                        raise RuntimeError("candidate source blob SHA CAS failed")
                if current:
                    cur.execute(
                        "UPDATE migration_revisions SET status='superseded' "
                        "WHERE revision_id=%s AND status='active'",
                        (current,),
                    )
                    if cur.rowcount != 1:
                        raise RuntimeError("active parent transition affected unexpected rows")
                cur.execute(
                    "UPDATE migration_revisions SET status='active', "
                    "activated_at=CURRENT_TIMESTAMP "
                    "WHERE revision_id=%s AND status='ready'",
                    (revision_id,),
                )
                if cur.rowcount != 1:
                    raise RuntimeError("candidate activation affected unexpected rows")
                cur.execute(
                    "UPDATE migration_state SET state_value=%s "
                    "WHERE state_key='active_revision_id' AND state_value=%s",
                    (revision_id, args.expected_active_revision),
                )
                if cur.rowcount != 1:
                    raise RuntimeError("active pointer update affected unexpected rows")
                cur.execute(
                    "SELECT state_value FROM migration_state "
                    "WHERE state_key='active_revision_id'"
                )
                activated = text((cur.fetchone() or [""])[0])
                if activated != revision_id:
                    raise RuntimeError("post-activation pointer verification failed")
                print(
                    json.dumps(
                        {
                            "status": "ok",
                            "activeRevisionId": activated,
                            "previousRevisionId": current,
                            "expectedActiveRevision": args.expected_active_revision,
                            "candidateParentRevision": text(parent_id),
                            "contentSha256": args.expected_content_sha256,
                            "sourceBlobSha": args.expected_source_blob_sha,
                            "sourceManifestSha256": args.expected_source_manifest_sha256,
                            "advisoryLock": PROJECT_ACTIVE_LOCK,
                        },
                        sort_keys=True,
                    )
                )
        return 0
    except Exception as exc:
        conn.rollback()
        print(f"PG_ACTIVATE_ERROR {type(exc).__name__}: {exc}")
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
