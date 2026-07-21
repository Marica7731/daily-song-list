# YouTube channel discovery

This tool is the replacement path for the old local song-name helper script when a single VSinger or VTuber channel needs補漏. It does not migrate `G:\VTUBER\歌名处理2026-03-07.py` directly, because the old script only produced song names and did not preserve video time, thumbnail, source identity, or review provenance.

## Scope

`scripts/youtube-channel-discovery.js` starts from one YouTube channel URL or handle, reads public channel tabs, filters likely song livestream candidates by title keyword, and optionally inspects each watch page with the same timestamp parser and curation path used by `scripts/update-songlist.js`.

Default title keywords:

- `LIVE`
- `歌`
- `弾き語`
- `リレー`

The discovery command writes review artifacts only. It does not mutate `data/latest.json`, `data/video-catalog.json`, the VSinger Moment raw tables, or the SQLite runtime database. Reviewed results are normally converted into a small accepted increment under `data/external/youtube-channel-discovery/accepted/`; the SQLite builder merges those increments at build time.

## Command

```bash
npm run youtube:discover-channel -- \
  --channel-url https://www.youtube.com/@noa_polaris \
  --singer-name "Noa Polaris" \
  --output-dir artifacts/channel-discovery/noa_polaris \
  --max-channel-pages 3 \
  --max-candidates 120 \
  --max-inspect 25 \
  --request-interval-ms 2500 \
  --request-jitter-ms 1000
```

Use `--candidate-only` for a low-cost first pass that fetches channel pages but does not inspect watch pages:

```bash
npm run youtube:discover-channel -- \
  --channel-url https://www.youtube.com/@kanaruhanon \
  --singer-name "Hanon" \
  --output-dir artifacts/channel-discovery/kanaruhanon \
  --candidate-only \
  --max-channel-pages 2
```

Resume by rerunning the same command without `--fresh`. The checkpoint is `checkpoint.json` inside the output directory. Use `--fresh` only when the previous checkpoint should be ignored.

## yt-dlp fallback

The default crawler uses the project HTTP client first. If YouTube channel pages or watch pages fail with transient network/TLS/429/5xx errors, discovery now falls back to local `yt-dlp` when available. The fallback is bounded by the same per-channel process timeout in batch mode and has its own per-command timeout:

```bash
npm run youtube:discover-channel -- \
  --channel-url https://youtube.com/@pannomimimi \
  --singer-name "Panno Mimimi" \
  --output-dir artifacts/channel-discovery/pannomimimi \
  --max-candidates 20 \
  --max-inspect 5 \
  --inspect-max-attempts 1 \
  --yt-dlp-path yt-dlp \
  --yt-dlp-comment-limit 80 \
  --yt-dlp-timeout-ms 90000
```

Use `--no-yt-dlp-fallback` to prove the primary HTTP path alone. yt-dlp page summaries are marked with `backend: "yt-dlp"` and `fallbackFrom`, so the manifest shows which channels needed the fallback.

## Pre-import dirty-data audit

Discovery output is not imported just because the crawler found timestamps. `youtube:import-channel-discovery` and `youtube:export-channel-increment` run a pre-import audit before writing catalog or accepted increment data. The audit records raw candidate counts, then classifies cleaned rows as `accepted`, `skipped`, `failed`, or `suspicious`.

Suspicious rows are held out of import. Review only those rows, then convert the decision into either a durable parser/curation rule or an explicit reviewed exception. Do not paste AI one-off judgments into accepted JSON without one of those durable records.

The audit treats these patterns as suspicious:

- narration, explanation, greetings, chat markers, and other non-song activity rows;
- one-off rows with no artist;
- one-off rows that still look weak after removing numbers, brackets, and sequence markers;
- Japanese explanation text split from an English translation as `title / artist`;
- OP/ED/Start/End/開始/タイムスタンプ/曲名 and bracket marker pollution.

Video cover is mandatory for import. The importer uses the fetched `thumbnailUrl` and falls back to the stable YouTube `hqdefault.jpg` URL for valid video IDs. A row that still has no cover is blocked by the audit. Channel avatar URLs are preserved when YouTube exposes them, but no fake avatar is invented.

Reviewed exceptions are optional and must be explicit:

```json
{
  "schemaVersion": 1,
  "accepted": [
    {
      "id": "review-2026-07-22-example",
      "videoId": "AAAAAAAAAAA",
      "seconds": 123,
      "title": "Song Title",
      "artist": "未記載",
      "reviewedBy": "operator",
      "reviewedAt": "2026-07-22T00:00:00Z",
      "reason": "manual source confirms this title-only row is a song"
    }
  ],
  "rejected": []
}
```

Pass it with `--audit-exceptions <path>`. Exceptions without `reviewedBy` and `reason` are ignored.

## Bounded batch rescan

For multi-channel補漏, use the batch runner instead of one long shell command. It runs channels sequentially, writes a resumable `batch-manifest.json` after each channel, keeps per-channel logs, enforces a timeout per channel, records a disk snapshot, and can export the accepted increment at the end.

Target list:

```bash
config/youtube-channel-backfill-targets.json
```

Default bounded run:

```bash
npm run youtube:backfill-channel-batch -- \
  --output-root artifacts/channel-discovery/source-rescan \
  --accepted-output data/external/youtube-channel-discovery/accepted/2026-07-22-source-rescan.json \
  --audit-exceptions config/youtube-channel-import-audit-exceptions.json \
  --max-channel-pages 100 \
  --max-candidates 0 \
  --max-inspect 1000 \
  --request-interval-ms 3000 \
  --request-jitter-ms 1500 \
  --per-channel-timeout-ms 1200000 \
  --inspect-max-attempts 1 \
  --yt-dlp-timeout-ms 90000 \
  --batch-size 1
```

Resume by rerunning the same command without `--fresh`; completed channels in `batch-manifest.json` are skipped. Use `--target <slug-or-url>` for a single channel smoke or retry, and `--rerun-completed` only when a completed output should be regenerated. Use `--no-export` when only discovery artifacts are wanted.

The current source-rescan target set covers:

- `NishizonoChigusa`
- `NekoyashikiMiku`
- `HaNaTaN_MUSiC`
- `isshiki-izu`
- `tenbin173`
- `Nijyuna714`
- `Nijyuuu7`
- `y_ha_ag_y`
- `monicoch`
- `RirisyaMusic`
- `KumahachiEma`
- `88nia88`
- `AoiFuu5`
- `963Noah`
- `suzu_kmkg`
- `UCTbEua7o1f8I7EMBQlLjTpQ`
- `YutoMuchiko`
- `Robocosan`
- `pannomimimi`

For `RirisyaMusic`, do not treat VSinger Moment rows as proof that YouTube discovery is complete. A channel is accepted only after its own discovery output has a completed marker, non-empty `video-details.json` when matching videos exist, and the exported increment records the channel in `inputSummaries`.

Mac build machine runner example:

```bash
ssh be@192.168.1.13
source ~/.daily-song-list-build-env && cd ~/daily-song-list
npm run youtube:backfill-channel-batch -- --output-root artifacts/channel-discovery/source-rescan --accepted-output data/external/youtube-channel-discovery/accepted/2026-07-22-source-rescan.json --per-channel-timeout-ms 1200000
```

## Output

Each run writes:

- `manifest.json`: run options, page summaries, counts, request metrics, and output file names.
- `raw-videos.json`: raw candidate videos discovered from channel pages.
- `video-details.json`: usable inspected videos returned by the existing song-list inspection path.
- `occurrences.json`: flat song occurrence preview records for later review/import tooling.
- `audits.json`: selected/no-usable/fetch-error source audit details from `fetchVideoSongList`.
- `report.md`: operator-readable summary and samples.
- `checkpoint.json`: resumable inspection state.

`manifest.json` also includes coverage counters for video time fields, video thumbnails, occurrence timestamps, and occurrence thumbnails. `channelAvatarUrl` is stored when YouTube exposes it; if no avatar is available, use the latest video thumbnail as display fallback rather than inventing a channel image.

Raw candidate shape:

```json
{
  "sourceSystem": "youtube_channel_discovery",
  "channelUrl": "https://www.youtube.com/@noa_polaris",
  "channelId": "UC...",
  "singerName": "Noa Polaris",
  "youtubeVideoId": "AAAAAAAAAAA",
  "youtubeUrl": "https://www.youtube.com/watch?v=AAAAAAAAAAA",
  "videoTitle": "歌枠 title",
  "channelName": "Noa Polaris",
  "thumbnailUrl": "https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg",
  "streamedAt": "2026-07-19T00:00:00.000Z",
  "publishedAt": "2026-07-19T00:00:00.000Z",
  "matchedKeywords": ["歌"],
  "discoverySourceUrl": "https://www.youtube.com/@noa_polaris/streams?hl=ja&persist_hl=1",
  "fetchedAt": "2026-07-19T00:00:00.000Z",
  "rawHash": "sha256..."
}
```

Derived occurrence preview shape:

```json
{
  "sourceSystem": "youtube_channel_discovery",
  "youtubeVideoId": "AAAAAAAAAAA",
  "youtubeUrl": "https://www.youtube.com/watch?v=AAAAAAAAAAA&t=754s",
  "videoTitle": "歌枠 title",
  "channelName": "Noa Polaris",
  "thumbnailUrl": "https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg",
  "publishedAt": "2026-07-19T00:00:00.000Z",
  "seconds": 754,
  "timestampText": "12:34",
  "rawTitle": "12:34 少女レイ / みきとP",
  "rawArtist": "みきとP",
  "cleanedTitle": "少女レイ",
  "cleanedArtist": "みきとP",
  "verificationStatus": "youtube_discovered",
  "provenance": {
    "kind": "comment_or_description_timestamp",
    "sourceId": "Ugx...",
    "sourceHash": "sha256...",
    "rawHash": "sha256..."
  }
}
```

## Sequential補漏 workflow

Run one channel at a time. After each channel:

1. Check the final marker:
   `CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK candidates=<n> inspected=<n> videos=<n> occurrences=<n>`.
2. Open `report.md` and `audits.json`.
3. If the channel has a different title or timestamp style, add parser/cleanup tests before running the next channel.
4. Keep accepted output under `artifacts/channel-discovery/<channel>/` until a separate import step converts reviewed occurrences into project data.

## Reviewed channel補漏 acceptance record

For reviewed channel補漏 passes, keep a before-and-after ledger in the release note, incident note, or PR body. Do not infer these numbers from local JSON alone: baseline and after-import values must come from the same API target, with query time, base URL, commit SHA, and `meta.source_latest_sha256` recorded.

The 2026-07-19 full補漏 pass uses one accepted increment per channel for these sources: `HanamaeHaru`, `aoineno`, `fujimiyakotoha`, `noa_polaris`, `kanaruhanon`, `naraetanV`, and `ChomaChannel`. Treat earlier capped smoke runs such as `--max-inspect 25` as diagnostics only; full production補漏 should run until the channel pages report `reachedEnd=true` or until an explicit incident note explains why a cap was used.

For each channel, record:

- Baseline before import: `view=videos` and `view=vtubers` API search totals, summary counters, and top returned records.
- Discovery result: output directory, final `CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK` marker, `manifest.generatedAt`, `requestStats.totalElapsedMs`, `candidateCount`, `usableVideoCount`, and `occurrenceCount`.
- Accepted increment: accepted JSON path and `CODEX_CHANNEL_DISCOVERY_INCREMENT_OK` read/accepted/skipped/occurrence counts.
- After import: the same `view=videos` and `view=vtubers` API searches after the accepted increment is in the SQLite build, including total deltas from baseline and representative top records.

Use this table shape for each reviewed channel:

| Channel | Baseline API result | Discovery elapsed / candidates / usable videos / occurrences | Accepted increment result | After-import API result |
| --- | --- | --- | --- | --- |
| `HanamaeHaru` | `view=videos`, `view=vtubers`: totals and top rows before import | `requestStats.totalElapsedMs`, `candidateCount`, `usableVideoCount`, `occurrenceCount` | accepted file plus export marker counts | same API queries after import, with deltas |
| `aoineno` | `view=videos`, `view=vtubers`: totals and top rows before import | `requestStats.totalElapsedMs`, `candidateCount`, `usableVideoCount`, `occurrenceCount` | accepted file plus export marker counts | same API queries after import, with deltas |
| `fujimiyakotoha` | `view=videos`, `view=vtubers`: totals and top rows before import | `requestStats.totalElapsedMs`, `candidateCount`, `usableVideoCount`, `occurrenceCount` | accepted file plus export marker counts | same API queries after import, with deltas |
| `noa_polaris` | same API probes; baseline should note any previous partial import | same discovery manifest fields | accepted file plus skipped-regression count | same API queries after import, with deltas |
| `kanaruhanon` | same API probes; baseline should note any previous partial import | same discovery manifest fields | accepted file plus skipped-regression count | same API queries after import, with deltas |
| `naraetanV` | same API probes; baseline should note any previous partial import | same discovery manifest fields | accepted file plus skipped-regression count | same API queries after import, with deltas |
| `ChomaChannel` | same API probes; baseline should note any previous partial import | same discovery manifest fields | accepted file plus skipped-regression count | same API queries after import, with deltas |

Minimum API probes for the ledger:

```bash
curl -fsS "$BASE/api/meta"
curl -fsS "$BASE/api/rankings?range=all&view=videos&q=HanamaeHaru&pageSize=5"
curl -fsS "$BASE/api/rankings?range=all&view=vtubers&q=HanamaeHaru&pageSize=5"
curl -fsS "$BASE/api/rankings?range=all&view=videos&q=aoineno&pageSize=5"
curl -fsS "$BASE/api/rankings?range=all&view=vtubers&q=aoineno&pageSize=5"
curl -fsS "$BASE/api/rankings?range=all&view=videos&q=fujimiyakotoha&pageSize=5"
curl -fsS "$BASE/api/rankings?range=all&view=vtubers&q=fujimiyakotoha&pageSize=5"
```

Also keep the `なれたん` search acceptance in the same note. It should prove that the channel補漏 is present and that narrowed search scopes are respected:

- `view=videos&q=なれたん` returns the reviewed video/source rows.
- `view=vtubers&q=なれたん` matches only VTuber/channel identity text.
- `view=songs&q=なれたん` returns songs from matching `なれたん` source rows. The displayed `count`, `videoCount`, and source previews must be contextual to the matched source rows, while all-site diagnostics remain in `globalCount` and `globalVideoCount`.
- `view=artists&q=なれたん` must not pass merely because the video title or channel name contains `なれたん`; that tab can only match real artist identity text.

Example full-channel pass:

```bash
npm run youtube:discover-channel -- --channel-url https://www.youtube.com/@noa_polaris --singer-name "Noa Polaris" --output-dir artifacts/channel-discovery/noa_polaris --max-channel-pages 100 --max-candidates 0 --max-inspect 1000 --request-interval-ms 3000 --request-jitter-ms 1500
npm run youtube:discover-channel -- --channel-url https://www.youtube.com/@kanaruhanon --singer-name "香鳴ハノン" --output-dir artifacts/channel-discovery/kanaruhanon --max-channel-pages 100 --max-candidates 0 --max-inspect 1000 --request-interval-ms 3000 --request-jitter-ms 1500
npm run youtube:discover-channel -- --channel-url https://www.youtube.com/@naraetanV --singer-name "奈羅花" --output-dir artifacts/channel-discovery/naraetanV --max-channel-pages 100 --max-candidates 0 --max-inspect 1000 --request-interval-ms 3000 --request-jitter-ms 1500
npm run youtube:discover-channel -- --channel-url https://www.youtube.com/@ChomaChannel --singer-name "Choma" --output-dir artifacts/channel-discovery/ChomaChannel --max-channel-pages 100 --max-candidates 0 --max-inspect 1000 --request-interval-ms 3000 --request-jitter-ms 1500
```

## Accepted increment

To publish reviewed `video-details.json` rows without committing a large runtime rebuild, export an accepted increment:

```bash
npm run youtube:export-channel-increment -- \
  --input-dir artifacts/channel-discovery/noa_polaris \
  --input-dir artifacts/channel-discovery/kanaruhanon \
  --audit-exceptions config/youtube-channel-import-audit-exceptions.json \
  --output data/external/youtube-channel-discovery/accepted/2026-07-19-manual-backfill.json
npm run db:build
npm run check:published:api -- http://127.0.0.1/
```

Multiple channel output folders can be passed by repeating `--input-dir`. The export command prints `CODEX_CHANNEL_DISCOVERY_INCREMENT_OK` with read, accepted, skipped-regression, and occurrence counts. It is idempotent by `videoId`; if a previously cataloged video has a richer song list than the channel discovery result, the increment skips that duplicate instead of replacing the catalog entry.

Accepted increment payloads include `inputSummaries[]`. For each channel, check:

- `imported`, `skipped`, `failed`
- `increments.videos`, `increments.songs`, `increments.occurrences`
- `coverage.acceptedVideos.publishedTimestamp`
- `coverage.acceptedVideos.thumbnailUrl`
- `coverage.acceptedOccurrences.seconds`
- `failedReasons` and `skippedReasons`
- `missingThumbnailVideoIds` must be empty for accepted videos
- `preImportAudit.raw`, `preImportAudit.cleaned`, `suspicious`, and `suspiciousReasons`

These counts are based on YouTube discovery artifacts, manual reviewed exceptions, and catalog regression protection. VSinger Moment rows do not mark a channel as imported or collected; only this YouTube discovery source and manually reviewed local records are trusted collected sources.

For fast local validation of YouTube-only補漏 rows, build a temporary DB without VSinger raw tables:

```bash
npm run db:build -- --no-vsinger --output artifacts/runtime/song-rank-youtube-check.sqlite
python scripts/db/query-runtime-db.py --db artifacts/runtime/song-rank-youtube-check.sqlite --range all --view songs --q なれたん --summary-only
```

This validates accepted channel increments and contextual search cheaply. It is not a replacement for the production full SQLite build, because `vsingerSongs` and VSinger source tables are intentionally omitted.

`scripts/db/export-runtime-rankings.js` loads all `data/external/youtube-channel-discovery/accepted/*.json` files by default when `npm run db:build` uses `--ranking-source js`. This keeps manual補漏 commits small: commit the accepted increment, code, and docs only; do not commit generated `data/ui`, `data/catalog-segments`, or range JSON shards for a DB-mode deployment.

`npm run youtube:import-channel-discovery` still exists as a local static/catalog fallback. It merges accepted `video-details.json` rows into `data/video-catalog.json` and refreshes catalog segments, then `npm run publish:catalog-runtime` rewrites `data/latest.json`, range files, diff files, and compact UI runtime shards. Use that path only when static GitHub Pages output must include the same manual補漏 rows.

Catalog refresh can also detect a refreshed source that drops timestamps from an already cataloged video. In that case `video-catalog.js` keeps the previous richer song list, leaves `qualityStatus` as `usable` for publishable data, and records the reason in `regressionAudit` for diff/review tooling.

## VPS/GitHub placement

For production maintenance, run discovery on a VPS worktree such as `/opt/culua/ytb-song-rank` and write outputs below `artifacts/channel-discovery/<channel>/`. The path stays isolated from other projects, and `artifacts/` remains ignored by git; only `data/external/youtube-channel-discovery/accepted/*.json` and source changes are committed.

The 2 GiB VPS2 should not build the full SQLite database locally. Continue using GitHub Actions for full DB builds and deployments, as documented in `docs/db-api-runtime.md` and `deploy/vps2/README.md`. The channel discovery tool is network-bound and sequential, so it can run on VPS2 as an operator補漏 helper without enabling `BUILD_DB_ON_VPS=1`.

## Validation

Local checks:

```bash
node --test test/youtube-channel-discovery.test.js
node --test test/import-channel-discovery.test.js
node --test test/youtube-channel-backfill-batch.test.js
node --test test/runtime-db.test.js
node --test test/video-catalog.test.js
node --check scripts/youtube-channel-discovery.js
node --check scripts/youtube-channel-discovery-core.js
node --check scripts/youtube-yt-dlp-fallback.js
node --check scripts/run-youtube-channel-backfill-batch.js
node --check scripts/import-channel-discovery.js
node --check scripts/export-channel-discovery-increment.js
node --check scripts/youtube-channel-discovery-runtime.js
```

For real channels, treat the run as usable only when the final marker is printed and `manifest.json` exists with non-negative `candidateCount`, `usableVideoCount`, and `occurrenceCount`.
