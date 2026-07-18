# SQLite/API runtime plan

This is the first deployable step away from committing tens of thousands of frontend JSON shards.

## What changes

- `scripts/db/build-runtime-db.py` builds `artifacts/runtime/song-rank.sqlite` from `data/latest.json`.
- `scripts/db/export-runtime-rankings.js` reuses the existing frontend/runtime JS merge rules to export derived ranking rows without writing `data/ui` shards.
- The same builder imports the public VSinger Moment backfill shards into normalized raw `external_*` tables.
- `scripts/db/query-runtime-db.py` provides smoke-test reads with a completion marker.
- `server/song_rank_api.py` serves read-only HTTP endpoints for rankings, metadata, health, and source details.
- `deploy/vps2/*` documents the staging service and nginx wiring for VPS2.

## Builder input and output

Input:

- `data/latest.json` for the currently published song-list runtime payload.
- `data/external/vsinger-http/backfill/manifest.json` plus its listed shards, when present.

Output:

- SQLite database at `artifacts/runtime/song-rank.sqlite` by default.
- Final success marker: `CODEX_RUNTIME_DB_BUILD_OK`.
- On failure, the builder exits non-zero and does not replace the previous database.

## Query API

Local commands:

```bash
npm run db:build
npm run db:export-runtime -- --output artifacts/runtime/runtime-rankings.jsonl
npm run db:probe -- --range all --view songs --page-size 10 --summary-only
npm run api:serve
npm run check:published:api -- https://ytb-song-rank.culua.com/
```

HTTP endpoints:

- `GET /healthz`
- `GET /api/meta`
- `GET /api/rankings?range=all&view=songs&page=1&pageSize=50`
- `GET /api/rankings?range=7d&view=artists&q=花`
- `GET /api/sources/{sourceDetailKey}`

Operator smoke tests:

```bash
curl -fsS http://127.0.0.1:8765/healthz
curl -fsS "http://127.0.0.1:8765/api/rankings?range=all&view=songs&q=%E5%B0%91%E5%A5%B3%E3%83%AC%E3%82%A4&pageSize=5"
npm run check:published:api -- http://127.0.0.1/
npm run check:published:api -- https://ytb-song-rank.culua.com/
```

### Endpoint contract

`GET /healthz`

- Returns `status`, `schemaVersion`, `builtAt`, `latestGeneratedAt`, and table `counts`.
- Use this for systemd/nginx/Cloudflare cutover checks.

`GET /api/meta`

- Returns `{ schemaVersion, meta, counts }`.
- The frontend uses this endpoint first. If it is reachable, the page uses SQLite/API mode; otherwise GitHub Pages static JSON remains the fallback.

`GET /api/rankings`

Supported query parameters:

- `range`: `7d` or `all`; default `all`.
- `view`: `songs`, `songIndex`, `artists`, `videos`, or `vsingerSongs`; default `songs`.
- `metric`: `occurrences` or `videos` for `songs` and `artists`; ignored as `count` for the other views.
- `q`: optional case-insensitive search against normalized title, artist, channel, and name text.
- `minCount`: optional minimum count for `songs` and `artists`; interpreted against `metric`.
- `page`: 1-based page number.
- `pageSize`: maximum 200.

Response fields:

- `totalCount`: number of rows after search and filters.
- `filteredBaseCount`: number of rows before search/min-count filters for the same range/view/metric.
- `totalOccurrenceCount`: sum of `count` across the filtered rows.
- `totalVideoCount`: sum of `videoCount` across the filtered rows.
- `records`: display-ready rows; song and artist rows include `sourceDetailKey` when full source details are available.

For filtered searches, the summary counters must be filtered counters. Do not fall back to full-site `counts.occurrences`; otherwise a search such as `少女レイ` displays the all-site occurrence total instead of the matched rows.

`GET /api/sources/{sourceDetailKey}`

- Returns `{ found, sourceKey, record }`.
- When `found=true`, `record.occurrences` contains the full source occurrence list sorted by stored position.
- The frontend uses this endpoint for "view all sources" in API mode, so large source lists stay out of initial ranking responses.

Supported ranking views in this first step:

- `songs`
- `songIndex`
- `artists`
- `videos`
- `vsingerSongs` for the full VSinger Moment song occurrence ranking stored in `external_*` tables

## Data layers

- Raw source tables are append-friendly and auditable: `external_songs`, `external_videos`, and `external_occurrences` keep the VSinger Moment source IDs and occurrence rows.
- Runtime entity tables are query support data: `videos`, `songs`, and `occurrences` are built from `data/latest.json` after VSinger import is applied.
- Derived query tables are display-ready: `ranking_rows`, `source_details`, and `source_occurrences` reuse `scripts/vsinger-http/runtime-importer.js` plus `assets/ranking-utils.js`, so title variants, song versions, artist aliases, and unknown-artist handling stay consistent with the frontend.
- `source_details` stores the entity summary and preview; `source_occurrences` stores the full derived source list by `source_key` so large songs do not become multi-megabyte JSON blobs.

The raw tables are intentionally not overwritten by cleanup decisions. Dirty data handling belongs in derived layers, so future canonical entity work can reprocess the same source rows without fetching the data again.

The `songs` view is the user-facing all-source ranking. For example, after the 2026-07-19 VSinger import, `songs?q=少女レイ` returns the frontend-equivalent merged row: `少女レイ / みきとP` with `count=2145` and `videoCount=1997`.

The `vsingerSongs` view remains a raw-source diagnostic view by VSinger song ID. Search responses include `totalOccurrenceCount` so operators can distinguish an exact source row from title variants matched by a search term.

## Maintenance contract

When changing any API field, ranking metric, derived merge rule, or source-detail shape, update all of these in the same change:

- This document's endpoint contract and smoke-test examples.
- `server/song_rank_api.py` response validation behavior.
- `scripts/db/build-runtime-db.py` and `scripts/db/export-runtime-rankings.js` when the derived rows change.
- `scripts/db/query-runtime-db.py` for operator probes.
- `scripts/check-published-runtime.js` so production checks cover the public contract.
- `test/runtime-db.test.js` and `test/runtime-api.test.js`.

## VPS2 rollout

Use `staging-ytb-song-rank.culua.com` first. The production domain `ytb-song-rank.culua.com` should stay on GitHub Pages until the VPS API and static frontend are verified.

Keep deploy paths isolated:

- `/opt/culua/ytb-song-rank` for the git checkout and static frontend.
- `/var/lib/culua/ytb-song-rank` for SQLite databases and runtime data that should migrate with the service.
- `/var/log/culua/ytb-song-rank` for service logs or future worker logs.

See `deploy/vps2/README.md` for the service and nginx commands.

## Update path

GitHub Actions remains the upstream data refresh path:

- `.github/workflows/update-core.yml` runs hourly and updates `data/latest.json`, `data/ui`, catalog files, and `data/status.json`.
- `.github/workflows/update-watchdog.yml` watches the published freshness and can trigger the core updater.
- `.github/workflows/update-backfill.yml` prepares backfill inbox bundles; VSinger full HTTP backfill stays behind owner-permission scripts and is not part of routine hourly refresh.
- After production cuts over to VPS2, set repository variable `DAILY_SONG_REQUIRE_PUBLISHED_API=1` so `.github/workflows/update-core.yml` fails if the static runtime is fresh but the public SQLite API is not healthy.

VPS2 is the runtime deploy target:

- `deploy/vps2/song-rank-runtime-update.timer` runs every 10 minutes.
- `deploy/vps2/song-rank-runtime-update.sh` pulls `origin/main`, builds SQLite into a temp file, probes `少女レイ`, atomically replaces the DB, restarts `song-rank-api`, and checks `/healthz`.
- The script emits `CODEX_RUNTIME_UPDATE_OK` only after the API is restarted and healthy.

If VPS2's 2 GiB memory is not enough for future data growth, switch the heavy DB build to GitHub Actions and let VPS2 only download a zipped `song-rank.sqlite` plus manifest, verify sha256, replace the DB, and restart the API.
