# PostgreSQL incremental release prototype

This directory is the migration-only write set. It does not change the
frontend, existing API URLs, response field names, or SQLite runtime files.

## Model

`pg-schema.sql` stores immutable revision overlays. A candidate writes only
changed videos and their complete replacement song occurrences. Unchanged rows
are resolved through `parent_revision_id`, so a daily upsert does not rebuild a
full SQLite database. Occurrences retain `range_id`, `occurrence_id`,
`source_id`, `source_system`, `raw_hash`, `song_key`, nullable `seconds`, and
the raw payload. Repeated seconds are valid; identity is `occurrence_id` when
present and otherwise the source position. `migration_state.active_revision_id`
is the only active pointer.

A deleted video is represented by an explicit tombstone row. Resolution stops
at that tombstone instead of inheriting the parent video or its occurrences;
rollback points back to the previous immutable revision.

The release gate is:

1. `prepareCandidate`: validate and stream upserts inside one transaction.
2. `compareRevisions`: calculate resolved counts, changed video IDs, and a
   deterministic content SHA-256.
3. `health`: resolve the candidate and run the API-compatible health contract.
4. `activateCandidate`: lock the state row and candidate, require the
   candidate parent to equal the currently active revision, then move the
   pointer only after the candidate is `ready` and its digest matches.
5. `rollbackActive`: restore the previous revision pointer without deleting the
   candidate or changing the old active data.

Any failed transaction leaves the old active pointer unchanged. The existing
SQLite `/healthz`, `/api/meta`, `/api/rankings`, and source URLs remain outside
this prototype until a production target and adapter are supplied.

## Inputs and streaming

`export-sqlite-records.py` opens an existing SQLite database read-only and emits
one video record at a time. `stream-sqlite-to-pg.mjs` feeds that NDJSON stream
to the candidate writer; it never copies SQLite, creates a second full DB, or
stores raw source data on a VPS.

## Production target gate

The supported production secret name is `DAILY_SONG_POSTGRES_DSN`. The adapter
also recognizes `DATABASE_URL` and `PG_DSN` for a controlled test environment,
but never prints their values. The current repository/Actions audit found no
such target or PostgreSQL driver, so ephemeral testing is not production
migration and must not trigger an active cutover.

## Focused test

Install `@electric-sql/pglite` only inside the Mac task temp root, set
`PGLITE_MODULE` to its resolved module path and optionally set
`PGLITE_DATA_DIR` below that same root, then run:

```bash
node --test test/pg-migration.test.mjs
```

Record the temp-root baseline/peak/after bytes and remove the whole temp root
on success, failure, or timeout. Only the small manifest, log, and report may
be retained outside it.
