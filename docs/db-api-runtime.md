# SQLite/API runtime plan

This is the first deployable step away from committing tens of thousands of frontend JSON shards.

## What changes

- `scripts/db/build-runtime-db.py` builds `artifacts/runtime/song-rank.sqlite` from `data/latest.json`.
- `scripts/db/export-runtime-rankings.js` reuses the existing frontend/runtime JS merge rules to export derived ranking rows without writing `data/ui` shards.
- The same builder imports the public VSinger Moment backfill shards into normalized raw `external_*` tables.
- The builder derives `channel_metadata` from reviewed YouTube channel discovery rows and cached public channel metadata.
- `scripts/db/query-runtime-db.py` provides smoke-test reads with a completion marker.
- `server/song_rank_api.py` serves read-only HTTP endpoints for rankings, metadata, health, and source details.
- The API exposes `view=vtubers` for channel/VTuber rankings; the frontend API-mode tab is `vtuberRank`.
- `deploy/vps2/*` documents the staging service and nginx wiring for VPS2.

## Builder input and output

Input:

- `data/latest.json` for the currently published song-list runtime payload.
- `data/external/vsinger-http/backfill/manifest.json` plus its listed shards, when present.
- `data/external/youtube-channel-discovery/accepted/*.json` for reviewed single-channel補漏 increments, when present.
- `data/external/youtube-channel-discovery/channel-metadata.json` for reviewed YouTube channel identity, real public channel `avatarUrl` cache, and latest video `thumbnailUrl` display fallback.

External補漏 rows pass through the same conservative non-song cleanup before they enter runtime rankings. High-confidence activity markers such as stream starts, setlist headers, timer notes, and sales/opening labels are dropped when the row has no reliable artist identity, while real songs with known artists, including the START whitelist, are preserved. Keep the regression probes for `開始` and `Start` with every manual補漏 batch so later imports do not reintroduce hidden-context song matches.

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

Do not regenerate and commit `data/ui`, `data/catalog-segments`, or range JSON shards just to publish a manual補漏 row. The JS runtime exporter overlays accepted increments and channel metadata in memory while building SQLite, so Git only needs the small reviewed JSON and source/cache changes. The normal hourly update path still uses `npm run update:core`, which refreshes `data/latest.json`, runs `scripts/fetch-channel-avatar-cache.js --daily`, then builds static runtime shards.

Deployment also avoids re-uploading the full database artifact by default. `.github/workflows/deploy-runtime-db.yml` builds and validates a complete SQLite file on GitHub Actions, then copies the active VPS2 database to a run-scoped candidate and uses `rsync --inplace --partial --compress` so only changed blocks cross the network. The active DB is replaced only after `song-rank-db-activate.sh` verifies the candidate sha256 and smoke query. Set repository variable `DAILY_SONG_UPLOAD_DB_ARTIFACT=1` only when a full SQLite Actions artifact is needed for inspection.

The regional VTuber blocklist keeps `config/blocked-vtuber-channels.json` as the canonical `Marica7731/mygit` mirror checked by CI. Repository-specific additions such as urgent source exclusions live in `config/blocked-vtuber-local-channels.json`; `npm run blocklist:generate`, backend Node imports, and `npm run blocklist:validate` use the merged effective list.

HTTP endpoints:

- `GET /healthz`
- `GET /api/meta`
- `GET /api/rankings?range=all&view=songs&page=1&pageSize=50`
- `GET /api/rankings?range=7d&view=artists&q=花`
- `GET /api/rankings?range=all&view=vtubers&q=HanamaeHaru&pageSize=5`
- `GET /api/sources/{sourceDetailKey}`
- `GET /api/sources/{sourceDetailKey}?page=1&pageSize=20`
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
- API mode normalizes `trend` filters to `all` and hides the trend selector entirely. Do not show the stale `API模式暂不支持趋势筛选` helper text in the query dialog.
- API mode maps the frontend `vtuberRank` tab to `view=vtubers`. Treat it as a channel/VTuber identity ranking, not as another artist ranking.
- The freshness chip uses SQLite `meta.built_at` / `rebuiltDerivedAt` as the staleness baseline. `meta.latest_captured_at` remains source-data provenance and must not trigger the 2-hour stale alert by itself.
- Song, artist, and VTuber summaries show two metrics: row count and `歌曲收录`. The frontend intentionally does not show a unique-video metric in those summaries. The video view still shows `个视频` and `个时间戳`.

`GET /api/rankings`

Supported query parameters:

- `range`: `7d` or `all`; default `all`.
- `view`: `songs`, `songIndex`, `artists`, `videos`, `vtubers`, or `vsingerSongs`; default `songs`.
- `metric`: `occurrences`, `count`, `songs`, or `videos`; `videos` is valid for `songs`, `artists`, and `vtubers`, and `songs` is valid for `vtubers`. Non-video/song metrics are normalized to occurrence counts in the response as `metric: "occurrences"`. For `songIndex`, `videos`, and `vsingerSongs`, the current implementation accepts any `metric` value and reads the occurrence-count rows.
- `q`: optional case-insensitive search. Terms match as continuous substrings, with whitespace/`AND`/`+`/`与`/`和` as AND and `OR`/`|`/`或` as OR group separators. Quote a phrase to keep spaces inside one term.
- `searchScope`: optional field selector. `all` is the default; for song-like ranking views it searches visible song identity fields only, while `channel`, `video`, and `source` must be selected explicitly when operators need source-context matches. `song`, `title`, `artist`, `channel`, `video`, `source`, and `entity` narrow the fields. `searchField` is accepted as a backward-compatible alias.
- `minCount`: optional minimum count. For `songs` and `artists`, `metric=videos` applies it to `videoCount`; otherwise it applies to `count`. For `videos` and `vtubers`, `minCount` is ignored by the UI/API ranking view.
- `page`: 1-based page number.
- `pageSize`: maximum 200.

Search scope contract:

- Default `searchScope=all` for `songs`, `songIndex`, `artists`, and `vsingerSongs` is intentionally identity-focused: a query must match visible song/artist/entity fields, not merely a channel name, video title, or parsed source note. Use `searchScope=channel`, `video`, or `source` when that broader evidence is required. All scopes still match complete continuous query terms; partial character reordering and wildcard expansion are not allowed.
- `searchScope=song` narrows `songs` and `songIndex` to song identity fields: title/work title, display artist, artist aliases, and variant labels that are visible as song identity.
- `searchScope=artist` narrows to singer/artist identity fields.
- `searchScope=channel` narrows to channel/VTuber identity fields such as `name`, `channelName`, `channelId`, `channelHandle`, and channel URL fields.
- `searchScope=video` narrows to video ID/title and video-level context.
- `searchScope=source` narrows to parsed source/timestamp context.
- `searchScope=entity` searches the visible primary entity text for the selected view.
- `avatarUrl` is backend data only when it is a real remote channel/avatar URL from runtime data, accepted discovery metadata, or `channel-metadata.json`. Generated fallback avatars must remain absent from DB/API payloads.
- `thumbnailUrl` / `videoThumbnailUrl` on `vtubers` records is display fallback only. It is sourced from the channel's latest available video/source thumbnail and is used when `avatarUrl` is empty. It is not counted as avatar coverage.
- `missingDisplayImage` must stay zero for runtime VTuber records. The daily avatar cache step and static/DB builders fail or report the offending channels when a record has neither real avatar nor video thumbnail.

Response fields:

- `totalCount`: number of rows after search and filters.
- `filteredBaseCount`: number of rows before search/min-count filters for the same range/view/metric.
- `totalOccurrenceCount`: sum of `count` across the filtered rows.
- `totalSongCount`: sum of `songCount` across filtered rows when available. It is mainly for `view=vtubers&metric=songs`.
- `totalVideoCount`: sum of `videoCount` across the filtered rows. It remains available for diagnostics and API clients, but the frontend summary does not display it for song, artist, or VTuber rankings because it is not a unique-video count.
- `pageCount`: total pages for the current filtered query.
- `records`: display-ready rows; song and artist rows include `sourceDetailKey` when full source details are available.

Record shapes are intentionally display-ready and may include extra frontend fields from `assets/ranking-utils.js`. Treat the following fields as stable:

| View | Stable record fields |
| --- | --- |
| `songs` | `rank`, `type`, `title`, `displayArtist`, `count`, `videoCount`, `timestampCount`, `artists`, `channels`, `occurrences` preview, `sourceDetailKey` when full details exist |
| `songIndex` | `rank`, `type`, `title`, `sortKey`, `count`, `videoCount`, `timestampCount`, `sourceDetailKey` when full details exist |
| `artists` | `rank`, `type`, `name`, `count`, `videoCount`, `timestampCount`, `songs` preview, `sourceDetailKey` when full details exist |
| `videos` | `rank`, `type`, `videoId`, `title`, `channelName`, `channelId`, `channelHandle`, `channelUrl`, `avatarUrl`, `sourceUrl`, `knownSourceType`, `isCollected`, `count`, `timestampCount`, `publishedTimestamp`, `publishedAt`, `timeMissingReason`, `thumbnailUrl` |
| `vtubers` | `rank`, `type`, `key`, `name`, `channelName`, `channelId`, `channelHandle`, `channelUrl`, `avatarUrl`, `thumbnailUrl`, `videoThumbnailUrl`, `sourceUrl`, `knownSourceType`, `isCollected`, `count`, `songCount`, `videoCount`, `timestampCount`, `songs` preview, `occurrences` preview |
| `vsingerSongs` | `rank`, `type`, `title`, `artist`, `singerName`, `count`, `videoCount`, `sourceDetailKey` when full details exist |

Sorting is by stored `rank` ascending for unfiltered and filtered requests. `songIndex` keeps alphabetical/index order.

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

Default song search is song-identity search. For example, `songs?q=なれたん` must not return rows solely because `なれたん` is present in channel/source/video evidence; use `songs?q=なれたん&searchScope=channel` or `searchScope=source` for that broader diagnostic. All modes must reject self-reference/commentary noise such as polls, setlist headers, and "songs I can sing" rows.

When an aggregate ranking row matches through source/channel/video evidence, the API returns only matching source previews and reports `count`, `timestampCount`, and `videoCount` for the matched subset. The original all-site values remain available as `globalCount`, `globalTimestampCount`, and `globalVideoCount`. This keeps a query such as `songs?q=なれたん` from showing unrelated top source previews or all-site play counts for a song that only has a few matching `なれたん` sources.

`npm run check:published:api` verifies the public contract for headers, bad-request and missing-route JSON errors, missing source details, filtered counters, the `少女レイ / みきとP` source detail count, default all-field `songs?q=なれたん`, narrowed `songs?q=なれたん&searchScope=song`, and the VSinger video-search probes for `ネモ・テルミナス` and `儚牙紺 - Kurage Kon -`.
It also probes the reviewed YouTube channel補漏 samples `ノア・ポラリス`, `香鳴ハノン`, `なれたん`, and `チョま` so a deploy cannot pass while the accepted increment is missing from the runtime DB.

`GET /api/sources/{sourceDetailKey}`

- Returns `{ found, sourceKey, record }`.
- Without `page` or `pageSize`, `record.occurrences` contains the full source occurrence list sorted by stored position for backward compatibility.
- With `page` or `pageSize`, the endpoint pages by unique source video in stored position order and returns only that page's occurrence rows. The response also includes `page`, `pageSize`, `pageCount`, `totalCount`, `totalVideoCount`, and `totalOccurrenceCount`.
- When `found=false`, the response is `{ schemaVersion, found: false, sourceKey }`.
- The frontend uses this endpoint for "view all sources" in API mode, so large source lists stay out of initial ranking responses.
- The frontend source drawer requests page size 20 on desktop/tablet and 10 on mobile so opening a song with thousands of sources does not download or insert the full list before first paint.

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
- `channel_metadata` is a query-support table keyed by channel ID, handle, or channel URL-derived handle. It stores `channelId`, `handle`, `displayName`, `avatarUrl`, `sourceUrl`, `channelUrl`, `knownSourceType`, and `isCollected` for backend clients.
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

Do not compare a default song-search screen directly to a per-singer補漏 count. `songs?q=<channel>` uses song-identity search and should not pass merely because a channel/source field matches; use `songs?q=<channel>&searchScope=channel` or `searchScope=source` only for explicit diagnostics. Per-singer補漏 is validated through singerId-scoped crawl reports, `videos?q=<singer name>`, `vtubers?q=<channel>`, and source-detail rows.

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
- Channel补漏 names such as `HanamaeHaru`, `aoineno`, and `fujimiyakotoha` should be checked in `view=videos` and `view=vtubers` after their accepted increment is imported. Use `searchScope=song`, `searchScope=artist`, or `searchScope=channel` when the acceptance needs to prove a specific field family rather than default all-field search.
- `なれたん` search acceptance should cover both search modes: default `view=songs&q=なれたん` must match the complete continuous term somewhere in the row and must not show self-reference/commentary noise; `view=songs&q=なれたん&searchScope=song` is the narrowed song-identity probe; `view=videos` and `view=vtubers` prove channel/source presence.

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
- Fast channel補漏 probe: `npm run db:build -- --no-vsinger --output artifacts/runtime/song-rank-youtube-check.sqlite`, then query `songs`, `videos`, and `vtubers` for the imported channel handles. Include `view=vtubers&metric=songs` to verify unique-song sorting. This is only a local YouTube overlay check; production still needs the full DB build.
- Avatar/display-image cache probe: `npm run youtube:fetch-channel-avatars -- --daily --dry-run --max-fetch 0 --delay-ms 0`, then `npm run youtube:fetch-channel-avatars -- --max-fetch 60 --delay-ms 1500` when new runtime channels need real channel avatars. Verify `CODEX_CHANNEL_AVATAR_CACHE_OK`, `missingDisplayImageAfter=0`, and ensure failures are reviewed before building SQLite.
- API smoke test: `npm run api:serve`, then `npm run check:published:api -- http://127.0.0.1/`.
- Frontend fallback check: VTuber cards/lists use `avatarUrl` first and `thumbnailUrl` / `videoThumbnailUrl` second. No default avatar image should render for normal runtime data; if a missing marker appears, treat it as a data/build failure.
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

- `.github/workflows/update-core.yml` runs hourly and updates `data/latest.json`, the incremental YouTube channel avatar cache, `data/ui`, catalog files, and `data/status.json`.
- `.github/workflows/update-watchdog.yml` watches published freshness and can trigger the core updater. After VPS2 cutover it reads `/api/meta` first and falls back to static `data/ui/meta.json` only when the API is unavailable.
- `.github/workflows/update-backfill.yml` prepares backfill inbox bundles; VSinger full HTTP backfill stays behind owner-permission scripts and is not part of routine hourly refresh.
- `.github/workflows/deploy-runtime-db.yml` runs on direct `main` pushes and after `Update core song-list data` completes successfully. It resolves the latest `origin/main` revision before building SQLite, then rsyncs the verified candidate database to VPS2 using the current active DB as the delta-transfer basis.
- After production cuts over to VPS2, set repository variable `DAILY_SONG_REQUIRE_PUBLISHED_API=1` so `.github/workflows/update-core.yml` verifies the production SQLite/API contract with `npm run check:published:api` instead of requiring the old GitHub Pages static JSON paths.

VPS2 is the runtime deploy target:

- `deploy/vps2/song-rank-db-activate.sh` verifies the uploaded DB sha256, probes `少女レイ`, atomically replaces the DB, restarts `song-rank-api`, and checks `/healthz`.
- `deploy/vps2/song-rank-runtime-update.timer` is installed but disabled on the 2 GiB production host. It is only a manual fallback for code sync and health restart, and it does not build SQLite unless `BUILD_DB_ON_VPS=1` is explicitly set.
- The activation script emits `CODEX_RUNTIME_DB_ACTIVATE_OK` only after the API is restarted and healthy.

VPS2's 2 GiB memory is not enough for the current full builder. Keep heavy DB builds in GitHub Actions or move the service to a larger host before setting `BUILD_DB_ON_VPS=1`; do not enable local scheduled DB builds on this host.

## 2026-07-20 release notes

Use the public API as the authority for whether source/data changes are online. A successful push or a green local test is not enough; verify:

```bash
curl -fsS "https://ytb-song-rank.culua.com/api/meta?probe=release-check"
npm run check:published:api -- https://ytb-song-rank.culua.com/
```

On 2026-07-20, production reported `source_commit_sha=19f35511bce858c195b102df5f59966a8040e9c3`, which includes the three source补跑 commits ending at `11646d70`, plus the default search hotfix. The deployed runtime counts were `videos=43872`, `songs=63924`, `occurrences=606400`, `ranking_rows=287661`, and `source_occurrences=908633`.

Successful deploy pattern:

- `Deploy SQLite runtime DB` run `29747764975` deployed the third source补跑 commit `11646d70` in 18m08s.
- `Deploy SQLite runtime DB` run `29752870596` deployed search hotfix commit `19f35511` in 15m52s.
- In the successful hotfix run, `Build runtime database` took 12m56s, `Verify runtime API artifact` took 4s, `Upload and activate database` took 1m41s, and `Verify VPS2 API` took 9s.

Failure pattern:

- Runs `29749201929` and `29751194001` failed in `Verify runtime API artifact` after about 5 minutes.
- Those failures did not activate any candidate database on VPS2; production stayed on the previous successful `source_commit_sha`.
- The root cause was a broad all-field aggregate search over `source_occurrences` during the API smoke probe. Keep default `searchScope=all` on the fast row-filter path unless the DB has an indexed/FTS-backed way to aggregate every matching source row.
- If this step fails, fix the API query path and rerun deploy. Do not retry upload or touch VPS2 manually, because the candidate was never activated.

Operational notes:

- `Check code` workflow failures are separate from the runtime DB deploy. They still need follow-up, but they do not prove production is stale when `Deploy SQLite runtime DB` is green and `/api/meta.source_commit_sha` matches the intended commit.
- `workflow_run` deploys may be skipped or cancelled by concurrency when a newer push deploy starts. The newest successful `Deploy SQLite runtime DB` and the public `/api/meta.source_commit_sha` are authoritative.
- Source补跑 status should be checked through accepted increment commits, runtime build counts, and live probes such as `view=videos&q=nanashi_77shi`, not by whether static `data/ui` shards were committed.
