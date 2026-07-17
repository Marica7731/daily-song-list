# VSinger Moment Public HTML Backfill

This pipeline imports VSinger Moment catalog and setlist data from public HTML pages only. It does not call `/api/*`, framework-private loaders, Server Actions, database endpoints, or guessed internal URLs.

Allowed public routes:

- `https://vsinger-moment.jp/robots.txt`
- `https://vsinger-moment.jp/songs`
- `https://vsinger-moment.jp/songs?cursor=...`
- `https://vsinger-moment.jp/streams`
- `https://vsinger-moment.jp/streams?cursor=...`
- `https://vsinger-moment.jp/songs/{uuid}`
- `https://vsinger-moment.jp/videos/{uuid}`

The crawler reads `robots.txt` before production work. If `/songs`, `/streams`, or `/videos` are disallowed, the scripts stop. The default request interval is `1000` ms and is raised automatically when robots declares a larger `Crawl-delay`.

## Singer-Scoped Pages

Public singer pages expose useful links such as `/songs?singerId=...` and `/songs/{uuid}?singerId=...`, and those pages can show per-singer song counts plus per-song occurrence positions. The path form `/singers/{uuid}` is allowed and useful for aggregate singer metadata, but it does not expose the full per-singer song and occurrence table. The full table currently depends on singer-scoped query pages, and the current `robots.txt` explicitly disallows query URLs containing `singerId` and `singerName`:

```text
Disallow: /*?*singerId=
Disallow: /*?*singerName=
```

Do not use singer-scoped query pages for production crawling unless `robots.txt` changes or the site owner gives explicit permission. They are acceptable only as manual investigation evidence. The automated crawler must continue to use robots-allowed public routes and MCP as the supplemental gap-fill path.

## Commands

Run the public capability probe first:

```bash
npm run vsinger:probe
```

Outputs:

- `artifacts/vsinger-http-backfill/probe.json`
- `artifacts/vsinger-http-backfill/probe.md`

Run small dry runs before full crawl:

```bash
npm run vsinger:crawl:songs -- --max-pages 10
npm run vsinger:crawl:streams -- --max-pages 10
```

Use `--fresh` when regenerating a report from the first page instead of resuming the saved checkpoint:

```bash
npm run vsinger:crawl:songs -- --fresh --max-pages 10
npm run vsinger:crawl:streams -- --fresh --max-pages 10
```

Run larger validation batches:

```bash
npm run vsinger:crawl:songs -- --max-pages 100
npm run vsinger:crawl:streams -- --max-pages 100
```

Run full crawls after the 10-page and 100-page reports are stable:

```bash
npm run vsinger:crawl:songs
npm run vsinger:crawl:streams
```

Fetch only queued video details:

```bash
npm run vsinger:fetch-video-details -- --queue artifacts/vsinger-http-backfill/streams/detail-queue.json
```

Do not fetch every `/videos/{uuid}` page. The streams crawler writes `detail-queue.json` only for videos that need补漏, such as missing setlists, missing YouTube IDs, missing song links, invalid timestamps, or conflicting public fields. A missing artist name in the list setlist does not by itself force a detail-page request.

Build the unified VPS bundle from existing crawl outputs:

```bash
npm run vsinger:build-bundle -- --songs-dir artifacts/vsinger-http-backfill/songs --streams-dir artifacts/vsinger-http-backfill/streams --video-details-dir artifacts/vsinger-http-backfill/video-details --output-dir data/external/vsinger-http/backfill
```

This step does not request VSinger Moment. It merges the public songs catalog crawl, stream-list setlists, and queued video-detail補漏 into one normalized bundle with coverage, failures, conflicts, sync state, and a request report.

## Configuration

- `VSINGER_HTTP_REQUEST_INTERVAL_MS`: default `1000`.
- `VSINGER_HTTP_USER_AGENT`: override the default crawler user agent.
- `VSINGER_HTTP_CONNECT_TIMEOUT_MS`: default `15000`.
- `VSINGER_HTTP_REQUEST_TIMEOUT_MS`: default `30000`.

The default user agent includes the project URL and contact location:

```text
daily-song-list-vsinger-http-backfill/0.1 (+https://github.com/Marica7731/daily-song-list; contact: github.com/Marica7731)
```

HTML cache and conditional request metadata are stored in:

```text
.local-cache/vsinger-http
```

The cache stores ETag and Last-Modified metadata, reuses `304 Not Modified`, and is intentionally not committed.

## Outputs

Dry-run and local crawl outputs are written under `artifacts/vsinger-http-backfill/`, which is ignored by Git:

- `songs/crawl.json`
- `songs/songs.json`
- `songs/checkpoint.json`
- `streams/crawl.json`
- `streams/videos.json`
- `streams/songs.json`
- `streams/occurrences.json`
- `streams/detail-queue.json`
- `streams/checkpoint.json`
- `streams/sync-state.json`
- `video-details/video-details.json`

For per-stage VPS bundle generation, pass `--write-bundle`:

```bash
npm run vsinger:crawl:songs -- --write-bundle --bundle-dir data/external/vsinger-http/songs
npm run vsinger:crawl:streams -- --write-bundle --bundle-dir data/external/vsinger-http/streams
```

For the unified backfill bundle, prefer `npm run vsinger:build-bundle` after the stage outputs exist. Bundle output is normalized and sharded:

- `manifest.json`
- `songs-0001.json`, ...
- `videos-0001.json`, ...
- `occurrences-0001.json`, ...
- `coverage.json`
- `failures.json`
- `syncState.json`
- `backfill-report.json`
- `backfill-report.md`

Large raw HTML is never committed. Raw HTML stays in `.local-cache/vsinger-http`.

## Data Model

Song entities:

- `canonicalSongId`
- `externalSongId`
- `displayTitle`
- `displayArtist`
- `titleAliases`
- `artistAliases`
- `sourceSystem`
- `sourceUrl`
- `provenance`
- `createdAt`
- `updatedAt`

Video entities:

- `youtubeVideoId`
- `externalVideoId`
- `title`
- `singerName`
- `streamedAt`
- `sourceUrl`
- `verificationStatus`

Occurrence entities:

- `youtubeVideoId`
- `canonicalSongId`
- `seconds`
- `sourceSystem`
- `externalSongId`
- `externalVideoId`
- `verificationStatus`
- `provenance`

HTTP-imported occurrences use:

```text
sourceSystem = vsinger_moment_http
verificationStatus = externally_reported
```

Only the existing YouTube verification pipeline may upgrade records to `youtube_verified`.

## Deduplication

Video key:

```text
youtubeVideoId
```

External song key:

```text
sourceSystem + externalSongId
```

Timed occurrence key:

```text
youtubeVideoId + canonicalSongId + seconds
```

Fallback occurrence key when no YouTube ID exists:

```text
externalVideoId + externalSongId + seconds
```

The pipeline does not dedupe a whole stream by video ID alone, and does not use raw title text as the final song key.

## Cursor Safety

The songs and streams crawlers persist:

- visited cursor URLs
- visited page hashes
- discovered song IDs or video IDs
- current cursor checkpoint
- coverage status

The crawler stops on:

- repeated cursor
- same page hash on consecutive pages
- five consecutive pages with no new IDs
- HTTP errors
- robots disallow

Missing records are not deleted by this pipeline. Downstream full-crawl reconciliation should mark first absence as `not_seen_in_latest_crawl`, and only mark `missing_from_source` after three complete successful crawls without the item.

## MCP Role

MCP remains a supplemental source only:

- crawler gap checks
- manual song lookup
- conflict details
- singer aliases
- specified songs
- specified video setlists
- latest small补漏

MCP must not be used for bulk `get_song` catalog construction.

## Validation

Run:

```bash
node --test test/vsinger-http.test.js
npm run check
```

The dedicated tests cover parser behavior, cursor loop detection, no-progress stop, count mismatch, YouTube ID extraction, ETag cache reuse, `429`, `403`, checkpoint resume, repeated same-song timestamps, and MCP supplement deduplication.
