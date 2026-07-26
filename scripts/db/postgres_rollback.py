#!/usr/bin/env python3
"""Rollback one applied PostgreSQL curation operation by operation ID."""

from __future__ import annotations

import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsn", required=True)
    parser.add_argument("--operation-id", required=True)
    args = parser.parse_args()
    try:
        import psycopg
    except ImportError:
        print("CODEX_POSTGRES_ROLLBACK_ERROR psycopg is required", file=sys.stderr)
        return 1
    try:
        with psycopg.connect(args.dsn) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT status FROM curation_operations WHERE operation_id=%s FOR UPDATE", (args.operation_id,))
                operation = cur.fetchone()
                if not operation:
                    raise ValueError("operation not found")
                if operation[0] == "rolled_back":
                    print("CODEX_POSTGRES_ROLLBACK_OK " + json.dumps({"operationId": args.operation_id, "alreadyRolledBack": True}))
                    return 0
                if operation[0] != "applied":
                    raise ValueError(f"operation status is not applied: {operation[0]}")
                cur.execute(
                    "SELECT occurrence_id, old_row_json::text, new_row_json::text FROM curation_operation_changes WHERE operation_id=%s ORDER BY occurrence_id",
                    (args.operation_id,),
                )
                changes = cur.fetchall()
                affected: set[tuple[str, str]] = set()
                for occurrence_id, old_json, new_json in changes:
                    if old_json is None:
                        new = json.loads(new_json or "{}")
                        affected.add((str(new.get("range_id") or "all"), str(new.get("song_key") or "")))
                        cur.execute("DELETE FROM occurrences WHERE occurrence_id=%s", (occurrence_id,))
                        continue
                    old = json.loads(old_json)
                    affected.add((str(old.get("range_id") or "all"), str(old.get("song_key") or "")))
                    cur.execute(
                        """
                        INSERT INTO occurrences
                        SELECT * FROM jsonb_populate_record(NULL::occurrences, %s::jsonb)
                        ON CONFLICT(occurrence_id) DO UPDATE SET
                          range_id=EXCLUDED.range_id, video_id=EXCLUDED.video_id, song_key=EXCLUDED.song_key,
                          seconds=EXCLUDED.seconds, source_system=EXCLUDED.source_system, source_id=EXCLUDED.source_id,
                          title=EXCLUDED.title, artist=EXCLUDED.artist, is_niche=EXCLUDED.is_niche,
                          is_unknown_artist=EXCLUDED.is_unknown_artist, payload_json=EXCLUDED.payload_json,
                          updated_at=EXCLUDED.updated_at
                        """,
                        (old_json,),
                    )
                for range_id, song_key in affected:
                    if not song_key:
                        continue
                    cur.execute(
                        """
                        INSERT INTO song_aggregates(range_id, song_key, occurrence_count, video_count)
                        SELECT %s, song_key, COUNT(*), COUNT(DISTINCT video_id)
                        FROM occurrences WHERE range_id=%s AND song_key=%s
                        GROUP BY song_key
                        ON CONFLICT(range_id, song_key) DO UPDATE SET
                          occurrence_count=EXCLUDED.occurrence_count,
                          video_count=EXCLUDED.video_count, updated_at=now()
                        """,
                        (range_id, range_id, song_key),
                    )
                cur.execute(
                    "UPDATE curation_operations SET status='rolled_back', result_json=result_json || %s::jsonb, applied_at=NULL WHERE operation_id=%s",
                    (json.dumps({"rollback": "complete", "restoredChanges": len(changes)}), args.operation_id),
                )
            conn.commit()
        print("CODEX_POSTGRES_ROLLBACK_OK " + json.dumps({"operationId": args.operation_id, "restoredChanges": len(changes)}))
    except Exception as exc:
        print(f"CODEX_POSTGRES_ROLLBACK_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
