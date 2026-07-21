# SQLite/API runtime plan

This is the first deployable step away from committing tens of thousands of frontend JSON shards.

## What changes

- `scripts/db/build-runtime-db.py` builds `artifacts/runtime/song-rank.sqlite` from `data/latest.json`.
- `scripts/db/export-runtime-rankings.js` reuses the existing frontend/runtime JS merge rules to export derived ranking rows without writing `data/ui` shards.
- The same builder imports the public VSinger Moment backfill shards into normalized raw `external_*` tables.
- `scripts/db/query-runtime-db.py` provides smoke-test reads with a completion marker.
- `server/song_rank_api.py` serves read-only HTTP endpoints for rankings, metadata, health, and source details.
- The API exposes `view=vtubers` for channel/VTuber rankings; the frontend API-mode tab is `vtuberRank`.
- `deploy/vps2/*` documents the staging service and nginx wiring for VPS2.

## Builder input and output

Input:

- `data/latest.json` for the currently published song-list runtime payload.
- `data/external/vsinger-http/backfill/manifest.json` plus its listed shards, when present.
- `data/external/youtube-channel-discovery/accepted/*.json` for reviewed single-channel補漏 increments, when present.

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

After reviewed single-channel discovery imports, export a small accepted increment and rebuild the DB:

```bash
npm run youtube:export-channel-increment -- --input-dir artifacts/channel-discovery/<channel> --output data/external/youtube-channel-discovery/accepted/<date>-<channel>.json
npm run db:build
```

Do not regenerate and commit `data/ui`, `data/catalog-segments`, or range JSON shards just to publish a manual補漏 row. The JS runtime exporter overlays accepted increments in memory while building SQLite, so Git only needs the small reviewed JSON and source changes. The normal hourly update path still uses `npm run update:core`.

Deployment also avoids re-uploading the full database artifact by default. `.github/workflows/deploy-runtime-db.yml` builds and validates a complete SQLite file on GitHub Actions, then copies the active VPS2 database to a run-scoped candidate and uses `rsync --inplace --partial --compress` so only changed blocks cross the network. The active DB is replaced only after `song-rank-db-activate.sh` verifies the candidate sha256 and smoke query. Set repository variable `DAILY_SONG_UPLOAD_DB_ARTIFACT=1` only when a full SQLite Actions artifact is needed for inspection.

HTTP endpoints:

- `GET /healthz`
- `GET /api/meta`
- `GET /api/rankings?range=all&view=songs&page=1&pageSize=50`
- `GET /api/rankings?range=7d&view=artists&q=花`
- `GET /api/rankings?range=all&view=vtubers&q=HanamaeHaru&pageSize=5`
- `GET /api/sources/{sourceDetailKey}`
- `GET /api/sources/{sourceDetailKey}?q=なれたん`

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
- API mode ignores legacy `trend` filters and does not render a trend selector or API-mode warning in the search controls.
- API mode maps the frontend `vtuberRank` tab to `view=vtubers`. Treat it as a channel/VTuber identity ranking, not as another artist ranking.
- The freshness chip uses SQLite `meta.built_at` / `rebuiltDerivedAt` as the staleness baseline. `meta.latest_captured_at` remains source-data provenance and must not trigger the 2-hour stale alert by itself.
- Song, artist, and VTuber summaries show two metrics: row count and `歌曲收录`. The frontend intentionally does not show a unique-video metric in those summaries. The video view still shows `个视频` and `个时间戳`.

`GET /api/rankings`

Supported query parameters:

- `range`: `7d` or `all`; default `all`.
- `view`: `songs`, `songIndex`, `artists`, `videos`, `vtubers`, or `vsingerSongs`; default `songs`.
- `metric`: `occurrences`, `count`, or `videos`; `videos` is valid for `songs`, `artists`, and `vtubers`. Non-video metrics are normalized to occurrence counts in the response as `metric: "occurrences"`. For `songIndex`, `videos`, and `vsingerSongs`, the current implementation accepts any `metric` value and reads the occurrence-count rows.
- `q`: optional case-insensitive search. The match scope is tab-specific; see below.
- `fields`: optional comma-separated search fields. Supported values are `title`, `artist`, `channel`, `video`, and `all`. Missing `fields` uses the view default; `fields=all` searches every supported field. The frontend serializes `fields` only when a non-empty `q` is present.
- `minCount`: optional minimum count. For `songs` and `artists`, `metric=videos` applies it to `videoCount`; otherwise it applies to `count`. For `videos` and `vtubers`, `minCount` is ignored by the UI/API ranking view.
- `page`: 1-based page number.
- `pageSize`: maximum 200.

Search scope contract:

- `songs` and `songIndex` default to `fields=title,artist`. They match source context only when `fields` includes `channel`, `video`, or `all`. When a song row is matched by source context, such as channel name or video title, the API derives contextual `count`, `videoCount`, `timestampCount`, and `occurrences` from the matching source rows only. It also keeps `globalRank`, `globalCount`, `globalVideoCount`, and `globalTimestampCount` for diagnostics.
- `vsingerSongs` defaults to `fields=title,artist` and matches source song title, artist, and singer fields. It is a raw-source diagnostic view and does not currently run the contextual source-row rewrite used by `songs`.
- `artists` defaults to `fields=artist` and matches singer/artist identity fields only, such as canonical name and aliases. Song titles, channel names, and video titles must not make an unrelated artist row match unless the request explicitly uses `fields=all`.
- `vtubers` defaults to `fields=channel` and matches channel/VTuber identity fields, such as `name`, `channelName`, `channelId`, `channelHandle`, and channel URL fields. Song titles and video titles must not make an unrelated VTuber row match by default.
- `videos` defaults to `fields=video,channel`. `fields=video` matches video ID/title, `fields=channel` matches channel identity, and `fields=title`, `fields=artist`, or `fields=all` also search parsed song-list/timestamp text.

Response fields:

- `totalCount`: number of rows after search and filters.
- `filteredBaseCount`: number of rows before search/min-count filters for the same range/view/metric.
- `totalOccurrenceCount`: sum of `count` across the filtered rows.
- `totalVideoCount`: sum of `videoCount` across the filtered rows. It remains available for diagnostics and API clients, but the frontend summary does not display it for song, artist, or VTuber rankings because it is not a unique-video count.
- `pageCount`: total pages for the current filtered query.
- `records`: display-ready rows; song and artist rows include `sourceDetailKey` when full source details are available.

Record shapes are intentionally display-ready and may include extra frontend fields from `assets/ranking-utils.js`. Treat the following fields as stable:

| View | Stable record fields |
| --- | --- |
| `songs` | `rank`, `type`, `title`, `displayArtist`, `count`, `videoCount`, `timestampCount`, `artists`, `channels`, `occurrences` preview, `sourceDetailKey` when full details exist; source-context searches may also include `matchedBySource`, `sourceFilterQuery`, `sourceDetailPath`, `globalRank`, `globalCount`, `globalVideoCount`, `globalTimestampCount` |
| `songIndex` | `rank`, `type`, `title`, `sortKey`, `count`, `videoCount`, `timestampCount`, `sourceDetailKey` when full details exist; source-context searches use the same contextual fields as `songs` |
| `artists` | `rank`, `type`, `name`, `count`, `videoCount`, `timestampCount`, `songs` preview, `sourceDetailKey` when full details exist |
| `videos` | `rank`, `type`, `videoId`, `title`, `channelName`, `count`, `timestampCount`, `publishedTimestamp`, `thumbnailUrl` |
| `vtubers` | `rank`, `type`, `key`, `name`, `channelName`, `channelId`, `channelHandle`, `channelUrl`, `count`, `videoCount`, `timestampCount`, `songs` preview, `occurrences` preview |
| `vsingerSongs` | `rank`, `type`, `title`, `artist`, `singerName`, `count`, `videoCount`, `sourceDetailKey` when full details exist |

Sorting is by stored `rank` ascending for unfiltered requests and for `songIndex`. For `songs` searches, the API re-ranks filtered results by the matching occurrence/video count so search result order is driven by matched collection count instead of the all-site rank.

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

For source-context searches, the summary counters must be contextual counters. For example, `songs?q=なれたん` can legitimately return songs that do not contain `なれたん` in the song title or artist, because they were sung in matching `なれたん` source videos. Those rows must display only the matching source preview and matching counts; global counts are exposed separately as `global*` diagnostics.

`npm run check:published:api` verifies the public contract for headers, bad-request and missing-route JSON errors, missing source details, filtered counters, the `少女レイ / みきとP` source detail count, contextual `なれたん` source previews and filtered source-detail fetches, and the VSinger video-search probes for `ネモ・テルミナス` and `儚牙紺 - Kurage Kon -`.
It also probes the reviewed YouTube channel補漏 samples `ノア・ポラリス`, `香鳴ハノン`, `なれたん`, and `チョま` so a deploy cannot pass while the accepted increment is missing from the runtime DB.

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
- `vtubers` for channel/VTuber occurrence and video rankings; frontend API mode calls this from `vtuberRank`
- `vsingerSongs` for the full VSinger Moment song occurrence ranking stored in `external_*` tables

## Data layers

- Raw source tables are append-friendly and auditable: `external_songs`, `external_videos`, and `external_occurrences` keep the VSinger Moment source IDs and occurrence rows.
- Runtime entity tables are query support data: `videos`, `songs`, and `occurrences` are built from `data/latest.json` after VSinger import is applied.
- Reviewed YouTube channel補漏 increments are small source-like overlays in `data/external/youtube-channel-discovery/accepted/*.json`; they are merged into the runtime entity build, but are not raw VSinger rows and do not rewrite the committed static JSON runtime.
- Derived query tables are display-ready: `ranking_rows`, `source_details`, and `source_occurrences` reuse `scripts/vsinger-http/runtime-importer.js`, `scripts/youtube-channel-discovery-runtime.js`, and `assets/ranking-utils.js`, so title variants, song versions, artist aliases, and unknown-artist handling stay consistent with the frontend.
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

Do not compare a song-search screen directly to a per-singer補漏 count without checking the match type. A source-context search such as `songs?q=儚牙紺` returns song rows derived from matching source occurrences, so the displayed `count` is contextual and the all-site count is in `globalCount`. Per-singer補漏 is still validated through singerId-scoped crawl reports, `videos?q=<singer name>`, `vtubers?q=<channel>`, and filtered source-detail rows.

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
- `ノア・ポラリス`, `香鳴ハノン`, `なれたん`, and `チョま` should be findable in `view=videos`, proving reviewed YouTube channel補漏 increments were included in the DB build.
- Channel补漏 names such as `HanamaeHaru`, `aoineno`, and `fujimiyakotoha` should be checked in `view=videos`, `view=vtubers`, and source-context `view=songs` after their accepted increment is imported. `view=songs` should show songs from matching source rows with contextual counts; `view=artists` should not pass solely because a video title or channel name contains the term.
- `なれたん` search acceptance should cover contextual search scopes: it must be findable in `view=videos`; `view=songs` should return the songs sung in matching `なれたん` source rows with `matchedBySource: true` and source previews that contain `なれたん`; `view=vtubers` should match only channel/VTuber identity text.

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

- DB build/probe: `npm run db:build` and `npm run db:probe -- --range all --view songs --q 少女レイ --page-size 5 --summary-only`; for channel補漏, also probe `--view videos --q ノア・ポラリス`.
- Fast channel補漏 probe: `npm run db:build -- --no-vsinger --output artifacts/runtime/song-rank-youtube-check.sqlite`, then query `songs`, `videos`, and `vtubers` for the imported channel handles. This is only a local YouTube overlay check; production still needs the full DB build.
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
- `.github/workflows/update-watchdog.yml` watches published freshness and can trigger the core updater. After VPS2 cutover it reads `/api/meta` first and falls back to static `data/ui/meta.json` only when the API is unavailable.
- `.github/workflows/update-backfill.yml` prepares backfill inbox bundles; VSinger full HTTP backfill stays behind owner-permission scripts and is not part of routine hourly refresh.
- `.github/workflows/deploy-runtime-db.yml` runs on direct `main` pushes and after `Update core song-list data` completes successfully. It resolves the latest `origin/main` revision before building SQLite, then rsyncs the verified candidate database to VPS2 using the current active DB as the delta-transfer basis.
- After production cuts over to VPS2, set repository variable `DAILY_SONG_REQUIRE_PUBLISHED_API=1` so `.github/workflows/update-core.yml` verifies the production SQLite/API contract with `npm run check:published:api` instead of requiring the old GitHub Pages static JSON paths.

VPS2 is the runtime deploy target:

- `deploy/vps2/song-rank-db-activate.sh` verifies the uploaded DB sha256, probes `少女レイ`, atomically replaces the DB, restarts `song-rank-api`, and checks `/healthz`.
- `deploy/vps2/song-rank-runtime-update.timer` is installed but disabled on the 2 GiB production host. It is only a manual fallback for code sync and health restart, and it does not build SQLite unless `BUILD_DB_ON_VPS=1` is explicitly set.
- The activation script emits `CODEX_RUNTIME_DB_ACTIVATE_OK` only after the API is restarted and healthy.

VPS2's 2 GiB memory is not enough for the current full builder. Keep heavy DB builds in GitHub Actions or move the service to a larger host before setting `BUILD_DB_ON_VPS=1`; do not enable local scheduled DB builds on this host.
