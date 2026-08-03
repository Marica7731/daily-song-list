#!/usr/bin/env python3
"""Install or remove the narrow PostgreSQL source-video search index."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from typing import Any


INDEX_NAME = "runtime_source_occurrences_video_search_trgm"
FUNCTION_NAME = "public.daily_song_source_video_search_text"
FUNCTION_SIGNATURE = f"{FUNCTION_NAME}(text,text,text)"
INDEX_EXPRESSION = (
    "public.daily_song_source_video_search_text(title, video_id, payload_json)"
)

CREATE_FUNCTION_SQL = r"""
CREATE OR REPLACE FUNCTION public.daily_song_source_video_search_text(
    source_title text,
    source_video_id text,
    source_payload_json text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
CALLED ON NULL INPUT
AS $function$
DECLARE
    parsed_payload jsonb;
    item_title text;
BEGIN
    item_title := NULL;
    IF source_payload_json IS NOT NULL AND btrim(source_payload_json) <> '' THEN
        BEGIN
            parsed_payload := source_payload_json::jsonb;
            item_title := parsed_payload -> 'item' ->> 'title';
        EXCEPTION WHEN invalid_text_representation THEN
            item_title := NULL;
        END;
    END IF;
    RETURN concat_ws(
        E'\n',
        NULLIF(btrim(source_title), ''),
        NULLIF(btrim(source_video_id), ''),
        NULLIF(btrim(item_title), '')
    );
END
$function$
""".strip()

CREATE_INDEX_SQL = f"""
CREATE INDEX CONCURRENTLY {INDEX_NAME}
ON public.runtime_source_occurrences
USING gin (({INDEX_EXPRESSION}) gin_trgm_ops)
""".strip()

DROP_INDEX_SQL = f"DROP INDEX CONCURRENTLY IF EXISTS public.{INDEX_NAME}"
DROP_FUNCTION_SQL = f"DROP FUNCTION IF EXISTS {FUNCTION_SIGNATURE}"

INDEX_STATE_SQL = """
SELECT index_class.oid,
       index_state.indisvalid,
       index_state.indisready,
       pg_get_indexdef(index_class.oid),
       pg_relation_size(index_class.oid)
FROM pg_class AS index_class
JOIN pg_namespace AS namespace
  ON namespace.oid = index_class.relnamespace
JOIN pg_index AS index_state
  ON index_state.indexrelid = index_class.oid
WHERE namespace.nspname = 'public'
  AND index_class.relname = %s
""".strip()

TABLE_STATE_SQL = """
SELECT count(*),
       pg_relation_size('public.runtime_source_occurrences'),
       pg_indexes_size('public.runtime_source_occurrences')
FROM public.runtime_source_occurrences
""".strip()


def _connect_from_env():
    if not os.environ.get("DAILY_SONG_POSTGRES_DSN") and not any(
        os.environ.get(name) for name in ("PGHOST", "PGDATABASE", "PGUSER")
    ):
        main_pid = subprocess.check_output(
            [
                "systemctl",
                "show",
                "song-rank-pg-api.service",
                "-p",
                "MainPID",
                "--value",
            ],
            text=True,
        ).strip()
        if not main_pid.isdigit() or main_pid == "0":
            raise RuntimeError("song-rank-pg-api MainPID unavailable")
        service_environment = {
            key.decode("utf-8"): value.decode("utf-8")
            for entry in open(f"/proc/{main_pid}/environ", "rb").read().split(b"\0")
            if b"=" in entry
            for key, value in [entry.split(b"=", 1)]
        }
        for name in (
            "DAILY_SONG_POSTGRES_DSN",
            "PGHOST",
            "PGDATABASE",
            "PGUSER",
            "PGPASSWORD",
            "PGPORT",
            "PGSSLMODE",
        ):
            if name in service_environment:
                os.environ[name] = service_environment[name]
    try:
        import psycopg
    except ImportError as error:  # pragma: no cover - production dependency
        raise RuntimeError("psycopg is required") from error
    dsn = os.environ.get("DAILY_SONG_POSTGRES_DSN")
    connection = psycopg.connect(dsn) if dsn else psycopg.connect()
    connection.autocommit = True
    return connection


def _read_index_state(cursor) -> dict[str, Any] | None:
    cursor.execute(INDEX_STATE_SQL, (INDEX_NAME,))
    row = cursor.fetchone()
    if row is None:
        return None
    oid, valid, ready, definition, size_bytes = row
    return {
        "oid": int(oid),
        "valid": bool(valid),
        "ready": bool(ready),
        "definition": str(definition),
        "sizeBytes": int(size_bytes),
    }


def _definition_matches(state: dict[str, Any]) -> bool:
    definition = " ".join(state["definition"].split())
    return (
        state["valid"]
        and state["ready"]
        and " USING gin " in f" {definition} "
        and INDEX_EXPRESSION in definition
        and "gin_trgm_ops" in definition
    )


def _read_table_state(cursor) -> dict[str, int]:
    cursor.execute(TABLE_STATE_SQL)
    rows, heap_bytes, index_bytes = cursor.fetchone()
    return {
        "rows": int(rows),
        "heapBytes": int(heap_bytes),
        "indexBytes": int(index_bytes),
    }


def ensure_index(connection) -> dict[str, Any]:
    with connection.cursor() as cursor:
        cursor.execute("SET lock_timeout = '30s'")
        cursor.execute("SET statement_timeout = 0")
        before_table = _read_table_state(cursor)
        before_index = _read_index_state(cursor)
        cursor.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        cursor.execute(CREATE_FUNCTION_SQL)

        rebuilt = False
        if before_index is not None and not _definition_matches(before_index):
            cursor.execute(DROP_INDEX_SQL)
            before_index = None
            rebuilt = True
        if before_index is None:
            cursor.execute(CREATE_INDEX_SQL)
            rebuilt = True

        after_index = _read_index_state(cursor)
        if after_index is None or not _definition_matches(after_index):
            raise RuntimeError("source video search index is absent or invalid after install")
        after_table = _read_table_state(cursor)

    return {
        "marker": "RUNTIME_SOURCE_VIDEO_SEARCH_INDEX_OK",
        "rebuilt": rebuilt,
        "function": FUNCTION_SIGNATURE,
        "index": INDEX_NAME,
        "beforeTable": before_table,
        "beforeIndex": before_index,
        "afterTable": after_table,
        "afterIndex": after_index,
    }


def rollback_index(connection) -> dict[str, Any]:
    with connection.cursor() as cursor:
        cursor.execute("SET lock_timeout = '30s'")
        cursor.execute("SET statement_timeout = 0")
        cursor.execute(DROP_INDEX_SQL)
        cursor.execute(DROP_FUNCTION_SQL)
        remaining = _read_index_state(cursor)
        if remaining is not None:
            raise RuntimeError("source video search index remains after rollback")
    return {
        "marker": "RUNTIME_SOURCE_VIDEO_SEARCH_INDEX_ROLLBACK_OK",
        "index": INDEX_NAME,
        "function": FUNCTION_SIGNATURE,
        "extensionRetained": "pg_trgm",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--rollback",
        action="store_true",
        help="drop only this index and helper; pg_trgm is deliberately retained",
    )
    args = parser.parse_args()
    connection = _connect_from_env()
    try:
        result = rollback_index(connection) if args.rollback else ensure_index(connection)
        print(json.dumps(result, sort_keys=True))
    finally:
        connection.close()


if __name__ == "__main__":
    main()
