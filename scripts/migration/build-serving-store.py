#!/usr/bin/env python3
"""Build a normalized read-only serving SQLite database from the canonical runtime DB.

Hard rules:
- copy source_details.source_key and source_occurrences.source_key verbatim;
- never hash title/artist/song_key;
- never rebuild full sources from compact three-preview ranking cards;
- source pagination is by distinct videoId, with occurrences stored as rows.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence

SCHEMA_VERSION = 4
BATCH_SIZE = 2000
MAX_RANKING_SEARCH_CHARS = 65_536
MAX_CHANNEL_SEARCH_CHARS = 32_768
DROP_PAYLOAD_KEYS = {"payload", "payload_json", "occurrence_payload_json", "video_payload_json"}
DETAIL_COLUMNS = ("source_key", "range_id", "entity_type", "entity_key", "payload_json")
OCCURRENCE_COLUMNS = (
    "source_key", "range_id", "position", "video_id", "title", "channel_name",
    "channel_id", "channel_handle", "channel_url", "published_timestamp", "seconds",
    "is_niche", "is_unknown_artist", "canonical_song_key",
    "canonical_song_name", "search_text", "payload_json",
)
RANKING_COLUMNS = (
    "row_id", "range_id", "view", "metric", "scope_key", "rank", "detail_key",
    "title", "artist", "name", "count", "song_count", "video_count",
    "timestamp_count", "payload_json", "search_text", "channel_search_text",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def chunks(rows: Iterable[Sequence[Any]], size: int = BATCH_SIZE) -> Iterator[list[Sequence[Any]]]:
    batch: list[Sequence[Any]] = []
    for row in rows:
        batch.append(row)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def open_readonly(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA busy_timeout=30000")
    # Keep every exported table in one read snapshot.  The runtime database may
    # be replaced or refreshed while a release is being built; mixing rows from
    # two revisions would be worse than failing the build.
    connection.execute("BEGIN")
    return connection


def table_names(connection: sqlite3.Connection) -> set[str]:
    return {str(row[0]) for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
    )}


def table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")}


def require_source_schema(connection: sqlite3.Connection) -> None:
    required_tables = {"meta", "source_details", "source_occurrences", "ranking_rows"}
    missing_tables = sorted(required_tables - table_names(connection))
    if missing_tables:
        raise RuntimeError("canonical runtime DB missing tables: " + ", ".join(missing_tables))
    for table, required in {
        "source_details": DETAIL_COLUMNS,
        "source_occurrences": OCCURRENCE_COLUMNS,
        "ranking_rows": RANKING_COLUMNS,
    }.items():
        missing = sorted(set(required) - table_columns(connection, table))
        if missing:
            raise RuntimeError(f"{table} missing columns: {', '.join(missing)}")


def source_meta(connection: sqlite3.Connection) -> dict[str, str]:
    try:
        return {str(row[0]): str(row[1]) for row in connection.execute("SELECT key,value FROM meta")}
    except sqlite3.DatabaseError:
        return {}


def validate_revision(meta: Mapping[str, str], expected: str) -> str:
    for key in ("active_revision_id", "activeRevisionId", "revision_id", "revisionId"):
        value = str(meta.get(key) or "").strip()
        if not value:
            continue
        if expected and value != expected:
            raise RuntimeError(f"source revision mismatch: {key}={value!r}, expected={expected!r}")
        return value
    return ""


def ranking_scope_counts(meta: Mapping[str, str]) -> dict[str, int]:
    raw = str(meta.get("ranking_scope_counts_json") or "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("canonical runtime DB has invalid ranking_scope_counts_json") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("canonical runtime DB ranking scope marker is not an object")
    result: dict[str, int] = {}
    for key, value in parsed.items():
        parts = str(key).split("/")
        if len(parts) != 4 or not all(parts):
            raise RuntimeError(f"canonical runtime DB has invalid ranking scope key: {key!r}")
        try:
            count = int(value)
        except (TypeError, ValueError) as exc:
            raise RuntimeError(f"canonical runtime DB has invalid ranking scope count: {key!r}") from exc
        if count < 0:
            raise RuntimeError(f"canonical runtime DB has negative ranking scope count: {key!r}")
        result[str(key)] = count
    declared = str(meta.get("ranking_scope_series") or "").strip()
    if declared and int(declared) != len(result):
        raise RuntimeError(
            f"canonical runtime DB ranking scope series mismatch: "
            f"declared={declared} actual={len(result)}"
        )
    return result


def create_schema(connection: sqlite3.Connection) -> None:
    connection.executescript("""
    PRAGMA journal_mode=OFF;
    PRAGMA synchronous=OFF;
    PRAGMA temp_store=FILE;
    PRAGMA cache_size=-32768;
    PRAGMA foreign_keys=OFF;

    CREATE TABLE serving_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;

    CREATE TABLE source_details(
      range_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      total_occurrence_count INTEGER NOT NULL DEFAULT 0,
      total_video_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(range_id,source_key)
    ) WITHOUT ROWID;

    CREATE TABLE source_occurrences(
      range_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_handle TEXT NOT NULL,
      channel_url TEXT NOT NULL,
      published_timestamp INTEGER,
      seconds INTEGER,
      is_niche INTEGER NOT NULL,
      is_unknown_artist INTEGER NOT NULL,
      canonical_song_key TEXT NOT NULL,
      canonical_song_name TEXT NOT NULL,
      search_text TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY(range_id,source_key,position)
    ) WITHOUT ROWID;

    CREATE TABLE source_videos(
      range_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      video_order INTEGER NOT NULL,
      video_id TEXT NOT NULL,
      first_position INTEGER NOT NULL,
      PRIMARY KEY(range_id,source_key,video_id),
      UNIQUE(range_id,source_key,video_order)
    ) WITHOUT ROWID;

    CREATE TABLE ranking_rows(
      id INTEGER PRIMARY KEY,
      row_id TEXT NOT NULL,
      range_id TEXT NOT NULL,
      view TEXT NOT NULL,
      metric TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      rank INTEGER NOT NULL,
      detail_key TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      name TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      song_count INTEGER NOT NULL,
      video_count INTEGER NOT NULL,
      timestamp_count INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      search_text TEXT NOT NULL,
      channel_search_text TEXT NOT NULL
    );
    """)


def copy_details(source: sqlite3.Connection, target: sqlite3.Connection) -> int:
    query = "SELECT " + ",".join(DETAIL_COLUMNS) + " FROM source_details ORDER BY range_id,source_key"
    insert = "INSERT INTO source_details(source_key,range_id,entity_type,entity_key,payload_json) VALUES(?,?,?,?,?)"
    total = 0
    for batch in chunks(source.execute(query)):
        target.executemany(insert, [tuple(row) for row in batch])
        total += len(batch)
    return total


def copy_occurrences(source: sqlite3.Connection, target: sqlite3.Connection) -> int:
    query = "SELECT " + ",".join(OCCURRENCE_COLUMNS) + " FROM source_occurrences ORDER BY range_id,source_key,position"
    insert = """
      INSERT INTO source_occurrences(
        source_key,range_id,position,video_id,title,channel_name,channel_id,channel_handle,
        channel_url,published_timestamp,seconds,is_niche,is_unknown_artist,
        canonical_song_key,canonical_song_name,search_text,payload_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """
    total = 0
    for batch in chunks(source.execute(query)):
        normalized = []
        for row in batch:
            values = list(row)
            for index in (3,4,5,6,7,8,13,14,15,16):
                values[index] = str(values[index] or ("{}" if index == 16 else ""))
            values[11] = 1 if values[11] else 0
            values[12] = 1 if values[12] else 0
            normalized.append(tuple(values))
        target.executemany(insert, normalized)
        total += len(normalized)
    return total


def distinct_previews(values: Any, limit: int = 3) -> list[dict[str,Any]]:
    if not isinstance(values,list):
        return []
    result: list[dict[str,Any]] = []
    seen: set[str] = set()
    for raw in values:
        if not isinstance(raw,dict):
            continue
        nested = raw.get("item") if isinstance(raw.get("item"),dict) else {}
        video_id = str(raw.get("videoId") or nested.get("videoId") or "")
        identity = f"video:{video_id}" if video_id else json.dumps(raw,ensure_ascii=False,sort_keys=True)
        if identity in seen:
            continue
        seen.add(identity)
        result.append({key:item for key,item in raw.items() if key not in DROP_PAYLOAD_KEYS})
        if len(result) >= limit:
            break
    return result


def compact_ranking_payload(value: Any, view: str) -> str:
    try:
        payload = json.loads(value) if isinstance(value,str) else dict(value or {})
    except (json.JSONDecodeError,TypeError,ValueError):
        payload = {}
    if not isinstance(payload,dict):
        payload = {}
    compact: dict[str,Any] = {}
    for key,item in payload.items():
        if key.startswith("_") or key in DROP_PAYLOAD_KEYS or key == "searchText":
            continue
        if key == "artists" and isinstance(item,list):
            compact[key] = item
        elif key == "songs" and isinstance(item,list) and view != "vtubers":
            compact[key] = item[:3] if view in {"artists", "videos"} else item
        elif item is None or isinstance(item,(str,int,float,bool)):
            compact[key] = item
    previews = distinct_previews(payload.get("occurrences"))
    compact["occurrences"] = previews
    compact["sourcePreviewCount"] = len(previews)
    try:
        total = int(payload.get("count") or payload.get("timestampCount") or 0)
    except (TypeError,ValueError):
        total = 0
    compact["occurrencePreviewLimited"] = bool(
        payload.get("occurrencePreviewLimited") or total > len(previews)
    )
    return json.dumps(compact,ensure_ascii=False,separators=(",",":"))


def copy_rankings(
    source: sqlite3.Connection,
    target: sqlite3.Connection,
    *,
    source_table: str = "ranking_rows",
    target_table: str = "ranking_rows",
) -> int:
    allowed_tables = {"ranking_rows", "ranking_rows_v3"}
    if source_table not in allowed_tables or target_table not in allowed_tables:
        raise ValueError("unsupported ranking table")
    query = (
        "SELECT " + ",".join(RANKING_COLUMNS) + f" FROM {source_table} "
        "ORDER BY range_id,view,metric,scope_key,rank"
    )
    insert = """
      INSERT INTO {target_table}(
        row_id,range_id,view,metric,scope_key,rank,detail_key,title,artist,name,row_count,
        song_count,video_count,timestamp_count,payload_json,search_text,channel_search_text
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """.format(target_table=target_table)
    total = 0
    for batch in chunks(source.execute(query)):
        normalized = []
        for row in batch:
            values = list(row)
            for index in (0,1,2,3,4,6,7,8,9):
                values[index] = str(values[index] or "")
            for index in (5,10,11,12,13):
                values[index] = int(values[index] or 0)
            values[14] = compact_ranking_payload(values[14],values[2])
            values[15] = str(values[15] or "")[:MAX_RANKING_SEARCH_CHARS]
            values[16] = str(values[16] or "")[:MAX_CHANNEL_SEARCH_CHARS]
            normalized.append(tuple(values))
        target.executemany(insert,normalized)
        total += len(normalized)
    return total


def create_in_place_schema(connection: sqlite3.Connection) -> None:
    """Add serving-only structures without copying the multi-gigabyte source tables.

    The input is an unpublished, disposable canonical snapshot.  A failed
    conversion is therefore discarded with the run root; it is never a live
    database and is not reused as a canonical artifact.
    """
    existing = table_names(connection)
    unexpected = sorted(
        existing.intersection({"serving_meta", "source_videos", "ranking_rows_v3"})
    )
    if unexpected:
        raise RuntimeError(
            "canonical runtime DB already has serving artifacts: " + ", ".join(unexpected)
        )
    detail_columns = table_columns(connection, "source_details")
    serving_columns = {"total_occurrence_count", "total_video_count"}
    if detail_columns.intersection(serving_columns):
        raise RuntimeError("canonical source_details already has serving count columns")
    connection.executescript("""
    PRAGMA journal_mode=OFF;
    PRAGMA synchronous=OFF;
    PRAGMA temp_store=FILE;
    PRAGMA cache_size=-32768;
    PRAGMA foreign_keys=OFF;

    ALTER TABLE source_details
      ADD COLUMN total_occurrence_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE source_details
      ADD COLUMN total_video_count INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE serving_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;

    CREATE TABLE source_videos(
      range_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      video_order INTEGER NOT NULL,
      video_id TEXT NOT NULL,
      first_position INTEGER NOT NULL,
      PRIMARY KEY(range_id,source_key,video_id),
      UNIQUE(range_id,source_key,video_order)
    ) WITHOUT ROWID;

    CREATE TABLE ranking_rows_v3(
      id INTEGER PRIMARY KEY,
      row_id TEXT NOT NULL,
      range_id TEXT NOT NULL,
      view TEXT NOT NULL,
      metric TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      rank INTEGER NOT NULL,
      detail_key TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      name TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      song_count INTEGER NOT NULL,
      video_count INTEGER NOT NULL,
      timestamp_count INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      search_text TEXT NOT NULL,
      channel_search_text TEXT NOT NULL
    );
    """)


def build_search_index(connection: sqlite3.Connection) -> str:
    """Build an index-backed substring search model.

    The trigram tokenizer is ideal for Japanese song-title substrings.  A
    unicode61 index is retained as a compatibility fallback for older SQLite
    builds; the server falls back to LIKE when that tokenizer cannot preserve
    substring semantics.
    """
    errors: list[str] = []
    for tokenizer in ("trigram", "unicode61"):
        try:
            connection.execute("DROP TABLE IF EXISTS ranking_search_fts")
            connection.execute(
                "CREATE VIRTUAL TABLE ranking_search_fts USING fts5("
                "search_text,channel_search_text,"
                "content='ranking_rows',content_rowid='id',"
                f"tokenize='{tokenizer}')"
            )
            connection.execute(
                "INSERT INTO ranking_search_fts(ranking_search_fts) VALUES('rebuild')"
            )
            return tokenizer
        except sqlite3.DatabaseError as exc:
            errors.append(f"{tokenizer}: {exc}")
    raise RuntimeError("SQLite FTS5 search index unavailable: " + "; ".join(errors))


def build_indexes(connection: sqlite3.Connection) -> str:
    connection.executescript("""
    CREATE INDEX idx_occurrence_page ON source_occurrences(range_id,source_key,position,video_id);
    CREATE INDEX idx_occurrence_video ON source_occurrences(range_id,source_key,video_id,position);
    CREATE INDEX idx_occurrence_flags ON source_occurrences(range_id,source_key,is_niche,is_unknown_artist,position);
    CREATE INDEX idx_occurrence_scope_song ON source_occurrences(
      range_id,source_key,is_niche,is_unknown_artist,canonical_song_key
    );
    CREATE INDEX idx_ranking_page ON ranking_rows(range_id,view,metric,scope_key,rank);
    CREATE INDEX idx_ranking_detail ON ranking_rows(range_id,detail_key);

    INSERT INTO source_videos(range_id,source_key,video_order,video_id,first_position)
    SELECT range_id,source_key,
           row_number() OVER(PARTITION BY range_id,source_key ORDER BY min(position),video_id),
           video_id,min(position)
    FROM source_occurrences
    WHERE video_id<>''
    GROUP BY range_id,source_key,video_id;

    CREATE TEMP TABLE source_counts AS
    SELECT range_id,source_key,count(*) AS occurrence_count,
           count(DISTINCT CASE WHEN video_id<>'' THEN video_id END) AS video_count
    FROM source_occurrences GROUP BY range_id,source_key;
    CREATE UNIQUE INDEX source_counts_key ON source_counts(range_id,source_key);

    UPDATE source_details SET
      total_occurrence_count=coalesce((SELECT occurrence_count FROM source_counts c
        WHERE c.range_id=source_details.range_id AND c.source_key=source_details.source_key),0),
      total_video_count=coalesce((SELECT video_count FROM source_counts c
        WHERE c.range_id=source_details.range_id AND c.source_key=source_details.source_key),0);
    """)
    return build_search_index(connection)


def iter_page_payloads(root: Path) -> Iterator[tuple[Path,dict[str,Any]]]:
    for path in sorted((root / "rankings").rglob("page-*.json*")):
        if path.suffix == ".gz":
            with gzip.open(path, "rt", encoding="utf-8") as stream:
                payload = json.load(stream)
        else:
            payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            yield path, payload


def validate_card_coverage(connection: sqlite3.Connection, ranking_root: Path) -> dict[str,Any]:
    available = {(str(r[0]),str(r[1])) for r in connection.execute("SELECT range_id,source_key FROM source_details")}
    checked = 0
    missing: list[dict[str,str]] = []
    by_series: dict[str,dict[str,int]] = {}
    for path,payload in iter_page_payloads(ranking_root):
        records = payload.get("records")
        if not isinstance(records,list):
            continue
        range_id = str(payload.get("rangeId") or payload.get("range") or "")
        view = str(payload.get("view") or "")
        metric = str(payload.get("metric") or "")
        if not range_id:
            parts = path.relative_to(ranking_root).parts
            if len(parts)>=4:
                range_id,view,metric = parts[1],view or parts[2],metric or parts[3]
        stat = by_series.setdefault(f"{range_id}/{view}/{metric}",{"cardsWithKey":0,"missing":0})
        for record in records:
            if not isinstance(record,dict):
                continue
            key = str(record.get("sourceDetailKey") or "").strip()
            if not key:
                continue
            checked += 1
            stat["cardsWithKey"] += 1
            if (range_id,key) not in available:
                stat["missing"] += 1
                if len(missing)<50:
                    missing.append({"path":str(path),"range":range_id,"view":view,"metric":metric,"key":key})
    if checked == 0:
        raise RuntimeError("coverage validation found no cards with sourceDetailKey")
    missing_count = sum(v["missing"] for v in by_series.values())
    if missing_count:
        raise RuntimeError(f"sourceDetailKey coverage failed: missing={missing_count} checked={checked} sample={json.dumps(missing[:10],ensure_ascii=False)}")
    return {"checked":checked,"missing":0,"bySeries":by_series}


def validate_database(
    connection: sqlite3.Connection,
    required_ranges: Sequence[str],
    ranking_root: Path,
    expected_scope_counts: Mapping[str, int] | None = None,
) -> dict[str,Any]:
    orphan = int(connection.execute("""
      SELECT count(*) FROM source_occurrences o LEFT JOIN source_details d
      ON d.range_id=o.range_id AND d.source_key=o.source_key WHERE d.source_key IS NULL
    """).fetchone()[0])
    if orphan:
        raise RuntimeError(f"serving store has {orphan} orphan occurrences")
    invalid_vtuber_identity = int(connection.execute("""
      SELECT count(*)
      FROM source_occurrences AS occurrence
      JOIN source_details AS detail
        ON detail.range_id=occurrence.range_id
       AND detail.source_key=occurrence.source_key
      WHERE detail.entity_type='vtuber'
        AND occurrence.canonical_song_key<>''
        AND occurrence.canonical_song_name=''
    """).fetchone()[0])
    if invalid_vtuber_identity:
        raise RuntimeError(
            "serving store has invalid VTuber canonical song identities: "
            f"{invalid_vtuber_identity}"
        )
    ambiguous_vtuber_identity = int(connection.execute("""
      SELECT count(*) FROM (
        SELECT occurrence.range_id,occurrence.source_key,
               occurrence.canonical_song_key
        FROM source_occurrences AS occurrence
        JOIN source_details AS detail
          ON detail.range_id=occurrence.range_id
         AND detail.source_key=occurrence.source_key
        WHERE detail.entity_type='vtuber'
          AND occurrence.canonical_song_key<>''
        GROUP BY occurrence.range_id,occurrence.source_key,
                 occurrence.canonical_song_key
        HAVING count(DISTINCT occurrence.canonical_song_name)<>1
      ) AS invalid
    """).fetchone()[0])
    if ambiguous_vtuber_identity:
        raise RuntimeError(
            "serving store has ambiguous VTuber canonical song identities: "
            f"{ambiguous_vtuber_identity}"
        )
    counts = {
        "sourceDetails": int(connection.execute("SELECT count(*) FROM source_details").fetchone()[0]),
        "sourceOccurrences": int(connection.execute("SELECT count(*) FROM source_occurrences").fetchone()[0]),
        "sourceVideos": int(connection.execute("SELECT count(*) FROM source_videos").fetchone()[0]),
        "rankingRows": int(connection.execute("SELECT count(*) FROM ranking_rows").fetchone()[0]),
        "rankingSearchRows": int(connection.execute("SELECT count(*) FROM ranking_search_fts").fetchone()[0]),
    }
    if counts["rankingSearchRows"] != counts["rankingRows"]:
        raise RuntimeError(
            f"ranking search row mismatch: fts={counts['rankingSearchRows']} rows={counts['rankingRows']}"
        )
    ranges: dict[str,dict[str,int]] = {}
    for row in connection.execute("""
      SELECT range_id,count(*),coalesce(sum(total_occurrence_count),0),coalesce(sum(total_video_count),0)
      FROM source_details GROUP BY range_id ORDER BY range_id
    """):
        ranges[str(row[0])] = {"details":int(row[1]),"occurrences":int(row[2]),"videos":int(row[3])}
    for range_id in required_ranges:
        stats = ranges.get(range_id)
        if not stats or stats["details"]<=0 or stats["occurrences"]<=0:
            raise RuntimeError(f"required range {range_id!r} is absent or empty")
    scope_counts = {
        f"{row[0]}/{row[1]}/{row[2]}/{row[3]}": int(row[4])
        for row in connection.execute("""
          SELECT range_id,view,metric,scope_key,count(*)
          FROM ranking_rows
          GROUP BY range_id,view,metric,scope_key
          ORDER BY range_id,view,metric,scope_key
        """)
    }
    if expected_scope_counts:
        expected = {str(key): int(value) for key, value in expected_scope_counts.items()}
        normalized_actual = {
            key: int(scope_counts.get(key, 0))
            for key in expected
        }
        unexpected = sorted(set(scope_counts) - set(expected))
        if normalized_actual != expected or unexpected:
            missing = sorted(
                key for key in set(expected) - set(scope_counts)
                if expected[key] != 0
            )
            mismatched = sorted(
                key for key in expected
                if normalized_actual[key] != expected[key]
            )
            raise RuntimeError(
                "ranking scope coverage mismatch: "
                f"missing={missing[:8]} unexpected={unexpected[:8]} "
                f"mismatched={mismatched[:8]}"
            )
        scope_counts = normalized_actual
    coverage = validate_card_coverage(connection, ranking_root)
    quick = str(connection.execute("PRAGMA quick_check").fetchone()[0])
    if quick.casefold() != "ok":
        raise RuntimeError(f"SQLite quick_check failed: {quick}")
    return {
        "counts":counts,
        "ranges":ranges,
        "rankingScopes":scope_counts,
        "coverage":coverage,
        "quickCheck":quick,
    }


def consume_canonical_snapshot(
    source_db: Path,
    ranking_root: Path,
    output: Path,
    *,
    active_revision_id: str,
    required_ranges: Sequence[str],
    built_at: str | None,
) -> dict[str, Any]:
    """Convert a disposable canonical snapshot into the serving store in place.

    The large source tables keep their existing SQLite pages.  Only the much
    smaller ranking table is rebuilt to gain an integer FTS rowid, then serving
    indexes and derived video/count tables are added.  The completed database
    is renamed to ``output`` on the same filesystem; no full-database copy or
    VACUUM is performed.
    """
    if source_db.resolve() == output.resolve():
        raise ValueError("consume-source output must differ from source DB")
    if output.exists():
        raise FileExistsError(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if source_db.stat().st_dev != output.parent.stat().st_dev:
        raise RuntimeError("consume-source conversion requires one filesystem")

    connection = sqlite3.connect(source_db)
    connection.row_factory = sqlite3.Row
    try:
        require_source_schema(connection)
        source_metadata = source_meta(connection)
        source_revision = validate_revision(source_metadata, active_revision_id)
        expected_scopes = ranking_scope_counts(source_metadata)
        details = int(connection.execute("SELECT count(*) FROM source_details").fetchone()[0])
        occurrences = int(
            connection.execute("SELECT count(*) FROM source_occurrences").fetchone()[0]
        )
        create_in_place_schema(connection)
        rankings = copy_rankings(
            connection,
            connection,
            source_table="ranking_rows",
            target_table="ranking_rows_v3",
        )
        if not details or not occurrences or not rankings:
            raise RuntimeError(
                f"empty serving store details={details} occurrences={occurrences} "
                f"rankings={rankings}"
            )
        connection.executescript("""
        DROP TABLE ranking_rows;
        ALTER TABLE ranking_rows_v3 RENAME TO ranking_rows;
        """)
        search_tokenizer = build_indexes(connection)
        validation = validate_database(
            connection,
            required_ranges,
            ranking_root,
            expected_scope_counts=expected_scopes,
        )
        metadata = {
            "schema_version": str(SCHEMA_VERSION),
            "active_revision_id": active_revision_id,
            "source_revision_marker": source_revision,
            "built_at": built_at or utc_now(),
            "canonical_source_key": "copied-from-source_details",
            "local_sources_ready": "1",
            "local_search_ready": "1",
            "search_tokenizer": search_tokenizer,
            "ranking_search_max_chars": str(MAX_RANKING_SEARCH_CHARS),
            "channel_search_max_chars": str(MAX_CHANNEL_SEARCH_CHARS),
            "ranking_payload_contract": "compact-v3",
            "ranking_scope_counts_json": json.dumps(
                validation["rankingScopes"],
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ),
            "ranking_scope_series": str(len(validation["rankingScopes"])),
            "ranges_json": json.dumps(
                validation["ranges"], ensure_ascii=False, sort_keys=True,
                separators=(",", ":"),
            ),
            "coverage_json": json.dumps(
                validation["coverage"], ensure_ascii=False, sort_keys=True,
                separators=(",", ":"),
            ),
            "counts_json": json.dumps(
                validation["counts"], ensure_ascii=False, sort_keys=True,
                separators=(",", ":"),
            ),
        }
        connection.executemany(
            "INSERT INTO serving_meta(key,value) VALUES(?,?)",
            sorted(metadata.items()),
        )
        connection.execute("DROP TABLE meta")
        connection.execute("ANALYZE")
        connection.execute("PRAGMA optimize")
        connection.commit()
    finally:
        connection.close()

    source_inode = source_db.stat().st_ino
    os.replace(source_db, output)
    if output.stat().st_ino != source_inode:
        raise RuntimeError("consume-source rename changed database inode")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "activeRevisionId": active_revision_id,
        "path": str(output),
        "bytes": output.stat().st_size,
        "sha256": sha256_file(output),
        "buildMode": "consume-canonical-in-place",
        "validation": validation,
    }


def build_serving_store(source_db: Path, ranking_root: Path, output: Path, *, active_revision_id: str,
                        required_ranges: Sequence[str] = ("7d","all"), built_at: str|None=None,
                        consume_source_db: bool = False) -> dict[str,Any]:
    if not source_db.is_file():
        raise FileNotFoundError(source_db)
    if not (ranking_root / "rankings").is_dir():
        raise FileNotFoundError(ranking_root / "rankings")
    if consume_source_db:
        return consume_canonical_snapshot(
            source_db,
            ranking_root,
            output,
            active_revision_id=active_revision_id,
            required_ranges=required_ranges,
            built_at=built_at,
        )
    output.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp_name = tempfile.mkstemp(prefix=f".{output.name}.",suffix=".tmp",dir=output.parent)
    os.close(fd)
    tmp = Path(tmp_name)
    tmp.unlink(missing_ok=True)
    source = open_readonly(source_db)
    target = sqlite3.connect(tmp)
    target.row_factory = sqlite3.Row
    try:
        require_source_schema(source)
        source_metadata = source_meta(source)
        source_revision = validate_revision(source_metadata,active_revision_id)
        expected_scopes = ranking_scope_counts(source_metadata)
        create_schema(target)
        details = copy_details(source,target)
        occurrences = copy_occurrences(source,target)
        rankings = copy_rankings(source,target)
        if not details or not occurrences or not rankings:
            raise RuntimeError(f"empty serving store details={details} occurrences={occurrences} rankings={rankings}")
        search_tokenizer = build_indexes(target)
        validation = validate_database(
            target,
            required_ranges,
            ranking_root,
            expected_scope_counts=expected_scopes,
        )
        metadata = {
            "schema_version":str(SCHEMA_VERSION),
            "active_revision_id":active_revision_id,
            "source_revision_marker":source_revision,
            "built_at":built_at or utc_now(),
            "canonical_source_key":"copied-from-source_details",
            "local_sources_ready":"1",
            "local_search_ready":"1",
            "search_tokenizer":search_tokenizer,
            "ranking_search_max_chars":str(MAX_RANKING_SEARCH_CHARS),
            "channel_search_max_chars":str(MAX_CHANNEL_SEARCH_CHARS),
            "ranking_payload_contract":"compact-v3",
            "ranking_scope_counts_json":json.dumps(
                validation["rankingScopes"],
                ensure_ascii=False,
                sort_keys=True,
                separators=(",",":"),
            ),
            "ranking_scope_series":str(len(validation["rankingScopes"])),
            "ranges_json":json.dumps(validation["ranges"],ensure_ascii=False,sort_keys=True,separators=(",",":")),
            "coverage_json":json.dumps(validation["coverage"],ensure_ascii=False,sort_keys=True,separators=(",",":")),
            "counts_json":json.dumps(validation["counts"],ensure_ascii=False,sort_keys=True,separators=(",",":")),
        }
        target.executemany("INSERT INTO serving_meta(key,value) VALUES(?,?)",sorted(metadata.items()))
        target.execute("ANALYZE")
        target.execute("PRAGMA optimize")
        target.commit()
        target.execute("VACUUM")
        target.commit()
    except Exception:
        target.close(); source.close(); tmp.unlink(missing_ok=True); raise
    else:
        target.close(); source.close()
    os.replace(tmp,output)
    return {"schemaVersion":SCHEMA_VERSION,"activeRevisionId":active_revision_id,"path":str(output),
            "bytes":output.stat().st_size,"sha256":sha256_file(output),"validation":validation}


def parse_args(argv: Sequence[str]|None=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-db",required=True,type=Path)
    parser.add_argument("--ranking-root",required=True,type=Path)
    parser.add_argument("--output",required=True,type=Path)
    parser.add_argument("--active-revision-id",required=True)
    parser.add_argument("--required-ranges",default="7d,all")
    parser.add_argument("--built-at",default="")
    parser.add_argument(
        "--consume-source-db",
        action="store_true",
        help="convert the disposable canonical snapshot in place and atomically rename it",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str]|None=None) -> int:
    args = parse_args(argv)
    try:
        result = build_serving_store(args.source_db,args.ranking_root,args.output,
            active_revision_id=args.active_revision_id,
            required_ranges=tuple(x.strip() for x in args.required_ranges.split(",") if x.strip()),
            built_at=args.built_at or None,
            consume_source_db=args.consume_source_db)
    except Exception as exc:
        print(f"SERVING_STORE_ERROR {type(exc).__name__}: {exc}",file=sys.stderr)
        return 1
    print("SERVING_STORE_OK "+json.dumps(result,ensure_ascii=False,sort_keys=True,separators=(",",":")))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
