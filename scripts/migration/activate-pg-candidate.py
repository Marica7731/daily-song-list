#!/usr/bin/env python3
"""Atomically activate a ready PostgreSQL runtime candidate."""

from __future__ import annotations

import argparse
import json
import psycopg


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision", required=True)
    parser.add_argument("--expected-content-sha256", required=True)
    args = parser.parse_args()
    conn = psycopg.connect("dbname=song_rank")
    try:
        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute("SELECT state_value FROM migration_state WHERE state_key='active_revision_id' FOR UPDATE")
                current = str((cur.fetchone() or [""])[0] or "")
                cur.execute("SELECT revision_id,parent_revision_id,status,content_sha256 FROM migration_revisions WHERE revision_id=%s FOR UPDATE", (args.revision,))
                row = cur.fetchone()
                if not row:
                    raise RuntimeError(f"candidate not found: {args.revision}")
                revision_id, parent_id, status, content_sha256 = row
                if status != "ready":
                    raise RuntimeError(f"candidate not ready: {args.revision} status={status}")
                if str(content_sha256 or "") != args.expected_content_sha256:
                    raise RuntimeError("candidate content sha256 mismatch")
                if str(parent_id or "") != current:
                    raise RuntimeError(f"candidate parent mismatch candidate={parent_id or '<none>'} active={current or '<none>'}")
                if current:
                    cur.execute("UPDATE migration_revisions SET status='superseded' WHERE revision_id=%s AND status='active'", (current,))
                cur.execute("UPDATE migration_revisions SET status='active', activated_at=CURRENT_TIMESTAMP WHERE revision_id=%s", (revision_id,))
                cur.execute("UPDATE migration_state SET state_value=%s WHERE state_key='active_revision_id'", (revision_id,))
                cur.execute("SELECT state_value FROM migration_state WHERE state_key='active_revision_id'")
                print(json.dumps({"status": "ok", "activeRevisionId": cur.fetchone()[0], "previousRevisionId": current}))
        return 0
    except Exception as exc:
        conn.rollback()
        print(f"PG_ACTIVATE_ERROR {type(exc).__name__}: {exc}")
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
