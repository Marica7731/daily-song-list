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

The runtime API contract covers `GET` requests. Non-GET methods are not part of the public contract in this first server and may return the Python stdlib default error page.

All API endpoints return compact JSON with `Content-Type: application/json; charset=utf-8` and `Access-Control-Allow-Origin: *`. Successful JSON responses use `Cache-Control: public, max-age=30`; JSON error responses use `Cache-Control: no-store`.

Common status codes:

- `200`: request succeeded.
- `400`: invalid query parameter; body is `{ "error": "bad_request", "message": "..." }`.
- `404`: unknown route; body is `{ "error": "not_found" }`.
- `500`: uncaught server error; body is `{ "error": "internal_error", "message": "..." }`.

Boundary behavior:

- Query parameters are parsed with the first value only; repeated parameters ignore later values.
- Unknown query parameters are ignored.
- `page` defaults to `1`; values below `1` are clamped to `1`.
- `pageSize` defaults to `50`; values below `1` are clamped to `1`, values above `200` are clamped to `200`.
- A page beyond `pageCount` returns `200` with an empty `records` array.
- `/api/sources/{sourceDetailKey}` returns `200 { "found": false }` for an unknown key. It only returns `400` when the key is empty.

Error examples:

```bash
curl -i "http://127.0.0.1:8765/api/rankings?range=bad"
# HTTP 400 {"error":"bad_request","message":"range must be 7d or all"}

curl -i "http://127.0.0.1:8765/api/nope"
# HTTP 404 {"error":"not_found"}

curl -fsS "http://127.0.0.1:8765/api/sources/codex-missing-source-key"
# HTTP 200 {"schemaVersion":1,"found":false,"sourceKey":"codex-missing-source-key"}
```

`GET /healthz`

- Returns `status`, `schemaVersion`, `builtAt`, `latestGeneratedAt`, and table `counts`.
- Use this for systemd/nginx/Cloudflare cutover checks.
- Example response:

```json
{
  "status": "ok",
  "schemaVersion": 1,
  "builtAt": "2026-07-19T00:00:00Z",
  "latestGeneratedAt": "2026-07-19T00:00:00.000Z",
  "counts": { "ranking_rows": 1, "source_occurrences": 1 }
}
```

`GET /api/meta`

- Returns `{ schemaVersion, meta, counts }`.
- `meta.source_commit_sha` is the git commit used when building SQLite.
- `meta.source_latest_sha256` is the sha256 of the `data/latest.json` consumed by the builder.
- The frontend uses this endpoint first. If it is reachable, the page uses SQLite/API mode; otherwise GitHub Pages static JSON remains the fallback.
- `scripts/check-published-runtime.js --mode api` can compare these fields to expected values with `--expected-commit-sha` and `--expected-latest-sha256`.

Operator fields:

- `counts.videos`, `counts.songs`, and `counts.occurrences` describe the current compact song-list data imported from `data/latest.json`.
- `counts.external_songs`, `counts.external_videos`, and `counts.external_occurrences` describe the raw VSinger Moment HTTP backfill rows retained for audit and reprocessing.
- `counts.ranking_rows` is the number of display-ready rows across ranges, views, metrics, and scopes.
- `counts.source_occurrences` is the number of derived source rows available behind `/api/sources/{sourceDetailKey}`.
- `meta.latest_generated_at`, `meta.latest_captured_at`, and `meta.latest_*` describe the source runtime payload.
- `meta.vsinger_status` must be `loaded` when the VSinger public HTML backfill was imported.
- `meta.vsinger_*` fields mirror the VSinger manifest counts and are used to diagnose missing raw-source imports.
- `meta.runtime_ranking_source` should be `runtime-js`; changing this means the API no longer uses the same derived ranking rules as the frontend.

Frontend API-mode behavior:

- When `/api/meta` returns a valid payload, the frontend enters SQLite/API mode and must not request `data/diff/latest-*.json`; those static diff files can resolve to HTML on the VPS/Nginx deployment and produce JSON parse toasts.
- API mode normalizes `trend` filters to `all`, disables the trend selector, and shows `API模式暂不支持趋势筛选`.
- The freshness chip uses SQLite `meta.built_at` / `rebuiltDerivedAt` as the staleness baseline. `meta.latest_captured_at` remains source-data provenance and must not trigger the 2-hour stale alert by itself.
- Broad unfiltered API summaries hide the all-site occurrence total because it is an internal source-row aggregate. Search/min-count/niche-filtered summaries still show matched `次收录`, and the video view still shows `个时间戳`.

`GET /api/rankings`

Supported query parameters:

- `range`: `7d` or `all`; default `all`.
- `view`: `songs`, `songIndex`, `artists`, `videos`, or `vsingerSongs`; default `songs`.
- `metric`: `occurrences`, `count`, or `videos`; `videos` is only valid for `songs` and `artists`. Non-video metrics are normalized to occurrence counts in the response as `metric: "occurrences"`. For `songIndex`, `videos`, and `vsingerSongs`, the current implementation accepts any `metric` value and reads the occurrence-count rows.
- `q`: optional case-insensitive search against normalized title, artist, channel, and name text.
- `minCount`: optional minimum count. For `songs` and `artists`, `metric=videos` applies it to `videoCount`; otherwise it applies to `count`. For `videos`, `minCount` is ignored because each row is a video row.
- `page`: 1-based page number.
- `pageSize`: maximum 200.

Response fields:

- `totalCount`: number of rows after search and filters.
- `filteredBaseCount`: number of rows before search/min-count filters for the same range/view/metric.
- `totalOccurrenceCount`: sum of `count` across the filtered rows.
- `totalVideoCount`: sum of `videoCount` across the filtered rows.
- `pageCount`: total pages for the current filtered query.
- `records`: display-ready rows; song and artist rows include `sourceDetailKey` when full source details are available.

Record shapes are intentionally display-ready and may include extra frontend fields from `assets/ranking-utils.js`. Treat the following fields as stable:

| View | Stable record fields |
| --- | --- |
| `songs` | `rank`, `type`, `title`, `displayArtist`, `count`, `videoCount`, `timestampCount`, `artists`, `channels`, `occurrences` preview, `sourceDetailKey` when full details exist |
| `songIndex` | `rank`, `type`, `title`, `sortKey`, `count`, `videoCount`, `timestampCount`, `sourceDetailKey` when full details exist |
| `artists` | `rank`, `type`, `name`, `count`, `videoCount`, `timestampCount`, `songs` preview, `sourceDetailKey` when full details exist |
| `videos` | `rank`, `type`, `videoId`, `title`, `channelName`, `count`, `timestampCount`, `publishedTimestamp`, `thumbnailUrl` |
| `vsingerSongs` | `rank`, `type`, `title`, `artist`, `singerName`, `count`, `videoCount`, `sourceDetailKey` when full details exist |

Sorting is by stored `rank` ascending. The database builder creates this order from the derived runtime export; the API does not re-rank rows after search and filters.

Example response shape:

```json
{
  "schemaVersion": 1,
  "rangeId": "all",
  "view": "songs",
  "metric": "occurrences",
  "page": 1,
  "pageSize": 5,
  "totalCount": 1,
  "filteredBaseCount": 1,
  "totalOccurrenceCount": 1,
  "totalVideoCount": 1,
  "pageCount": 1,
  "records": [
    {
      "rank": 1,
      "title": "少女レイ",
      "displayArtist": "みきとP",
      "count": 1,
      "videoCount": 1,
      "sourceDetailKey": "example"
    }
  ]
}
```

For filtered searches, the summary counters must be filtered counters. Do not fall back to full-site `counts.occurrences`; otherwise a search such as `少女レイ` displays the all-site occurrence total instead of the matched rows.

`npm run check:published:api` verifies the public contract for headers, bad-request and missing-route JSON errors, missing source details, filtered counters, the `少女レイ / みきとP` source detail count, and the VSinger video-search probes for `ネモ・テルミナス` and `儚牙紺 - Kurage Kon -`.

`GET /api/sources/{sourceDetailKey}`

- Returns `{ found, sourceKey, record }`.
- When `found=true`, `record.occurrences` contains the full source occurrence list sorted by stored position.
- When `found=false`, the response is `{ schemaVersion, found: false, sourceKey }`.
- The frontend uses this endpoint for "view all sources" in API mode, so large source lists stay out of initial ranking responses.
- This endpoint is intentionally unpaginated in the first database runtime. Keep it behind an explicit user action, and include a large-source smoke test before raising nginx/API timeouts or changing the response shape.

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

The `songs` view is the user-facing all-source ranking. For example, `songs?q=少女レイ` should return the frontend-equivalent merged row for `少女レイ / みきとP`; the exact `count` and `videoCount` change as source data refreshes, so use `npm run check:published:api` or `scripts/db/query-runtime-db.py` for the current numbers.

The `vsingerSongs` view remains a raw-source diagnostic view by VSinger song ID. Search responses include `totalOccurrenceCount` so operators can distinguish an exact source row from title variants matched by a search term.

Singer catalog freshness is tracked separately in `data/external/vsinger-http/singer-catalog.json` and summarized in `data/external/vsinger-http/singer-catalog-report.md`. Generate it from the current public `/singers` listing:

```bash
npm run vsinger:crawl:singers -- --fresh --output-dir artifacts/vsinger-http-backfill/current-singers --request-interval-ms 1500
npm run vsinger:audit:singers -- --singers-file artifacts/vsinger-http-backfill/current-singers/singers.json --backfill-dir data/external/vsinger-http/backfill
```

The audit compares the source singer list to committed VSinger videos by exact `singerName`, because the current normalized bundle does not yet keep `externalSingerId` on `external_videos`. Treat `missing-by-name` as high-confidence補漏 targets. Treat `source-ahead-by-name` as a conservative queue; renamed singers can appear there until refreshed by singerId.

Do not compare a song-search screen directly to a per-singer補漏 count. A search such as `songs?q=儚牙紺` returns global song rows whose `count` values are all-site totals for those songs. Per-singer補漏 is validated through singerId-scoped crawl reports, `videos?q=<singer name>`, and source-detail occurrence rows.

## Production verification probes

Use these probes after every API, DB builder, deployment, DNS, or Cloudflare change:

```bash
npm run check:published:api -- https://ytb-song-rank.culua.com/
curl -fsS https://ytb-song-rank.culua.com/healthz
curl -fsS "https://ytb-song-rank.culua.com/api/rankings?range=all&view=songs&q=%E5%B0%91%E5%A5%B3%E3%83%AC%E3%82%A4&pageSize=5"
```

Current qualitative acceptance points:

- `少女レイ` should return a merged `songs` row whose `title` is `少女レイ`, `displayArtist` includes `みきとP`, `totalOccurrenceCount` is much smaller than full-site `counts.source_occurrences`, and `/api/sources/{sourceDetailKey}` returns the same count as the ranking row.
- `ネモ・テルミナス` should be findable in `view=videos`, proving the newly missing-by-name singer has been imported.
- `儚牙紺 - Kurage Kon -` should be findable in `view=videos`, proving the second newly missing-by-name singer has been imported.

The exact counts change with each hourly refresh. Record the numbers from the command output in release notes or incident notes instead of hard-coding them in docs.

## Maintenance contract

When changing any API field, ranking metric, derived merge rule, or source-detail shape, update all of these in the same change:

- This document's endpoint contract and smoke-test examples.
- `server/song_rank_api.py` response validation behavior.
- `scripts/db/build-runtime-db.py` and `scripts/db/export-runtime-rankings.js` when the derived rows change.
- `scripts/db/query-runtime-db.py` for operator probes.
- `scripts/check-published-runtime.js` so production checks cover the public contract.
- `test/runtime-db.test.js` and `test/runtime-api.test.js`.
- This document whenever a route, query parameter, response field, error shape, cache/CORS rule, deployment path, or verification probe changes.

Before merging an API or deploy change, run this minimum contract matrix:

- DB build/probe: `npm run db:build` and `npm run db:probe -- --range all --view songs --q 少女レイ --page-size 5 --summary-only`.
- API smoke test: `npm run api:serve`, then `npm run check:published:api -- http://127.0.0.1/`.
- Frontend fallback check: load the static page without the API or run the normal static `npm run check:published -- <base-url>` path.
- Deployment check: after GitHub Actions uploads the DB, run `npm run check:published:api -- http://127.0.0.1/` on VPS2 and again against the public domain after DNS cutover.

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
- `.github/workflows/deploy-runtime-db.yml` runs on direct `main` pushes and after `Update core song-list data` completes successfully. It resolves the latest `origin/main` revision before building SQLite, then uploads the finished database to VPS2.
- After production cuts over to VPS2, set repository variable `DAILY_SONG_REQUIRE_PUBLISHED_API=1` so `.github/workflows/update-core.yml` verifies the public homepage and SQLite API instead of requiring the old GitHub Pages static JSON paths.

VPS2 is the runtime deploy target:

- `deploy/vps2/song-rank-db-activate.sh` verifies the uploaded DB sha256, probes `少女レイ`, atomically replaces the DB, restarts `song-rank-api`, and checks `/healthz`.
- `deploy/vps2/song-rank-runtime-update.timer` is installed but disabled on the 2 GiB production host. It is only a manual fallback for code sync and health restart, and it does not build SQLite unless `BUILD_DB_ON_VPS=1` is explicitly set.
- The activation script emits `CODEX_RUNTIME_DB_ACTIVATE_OK` only after the API is restarted and healthy.

VPS2's 2 GiB memory is not enough for the current full builder. Keep heavy DB builds in GitHub Actions or move the service to a larger host before setting `BUILD_DB_ON_VPS=1`; do not enable local scheduled DB builds on this host.
