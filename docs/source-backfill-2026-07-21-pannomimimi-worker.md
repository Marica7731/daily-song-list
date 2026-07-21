# 2026-07-21 pannomimimi YouTube source backfill worker

This note records the scoped single-channel YouTube discovery/import pass for:

- `https://youtube.com/@pannomimimi`

Moment/runtime presence was not used as collected evidence. The accepted rows
below come only from this worker's YouTube channel discovery output.

## Commands

Candidate preflight:

```powershell
npm run youtube:discover-channel -- --channel-url https://youtube.com/@pannomimimi --singer-name pannomimimi --output-dir artifacts/channel-discovery/2026-07-21-single-source-pannomimimi/pannomimimi --candidate-only --max-channel-pages 3 --request-interval-ms 2500 --request-jitter-ms 1000 --fresh
```

Marker:

```text
CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@pannomimimi" candidates=37 inspected=0 videos=0 occurrences=0 elapsedSeconds=20 outputDir="D:\Projects\daily_song_list_push_hotfix_20260720\artifacts\channel-discovery\2026-07-21-single-source-pannomimimi\pannomimimi"
```

Full discovery:

```powershell
npm run youtube:discover-channel -- --channel-url https://youtube.com/@pannomimimi --singer-name "パン野実々美" --output-dir artifacts/channel-discovery/2026-07-21-single-source-pannomimimi/pannomimimi --max-channel-pages 100 --max-candidates 0 --max-inspect 1000 --request-interval-ms 3000 --request-jitter-ms 1500 --fresh
```

Marker:

```text
CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@pannomimimi" candidates=37 inspected=37 videos=27 occurrences=245 elapsedSeconds=499 outputDir="D:\Projects\daily_song_list_push_hotfix_20260720\artifacts\channel-discovery\2026-07-21-single-source-pannomimimi\pannomimimi"
```

Accepted increment:

```powershell
npm run youtube:export-channel-increment -- --input-dir artifacts/channel-discovery/2026-07-21-single-source-pannomimimi/pannomimimi --output data/external/youtube-channel-discovery/accepted/2026-07-21-pannomimimi-worker.json
```

Marker:

```text
CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=27 usableVideos=27 acceptedVideos=27 skippedRegressions=0 occurrences=245 output="D:\Projects\daily_song_list_push_hotfix_20260720\data\external\youtube-channel-discovery\accepted\2026-07-21-pannomimimi-worker.json"
```

## Channel status

| Channel | Status | Candidate videos | Inspected videos | Usable videos | Accepted videos | Accepted songs | Accepted occurrences | Skipped regressions | Failed videos | Manifest |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `@pannomimimi` | imported | 37 | 37 | 27 | 27 | 204 | 245 | 0 | 0 | `artifacts/channel-discovery/2026-07-21-single-source-pannomimimi/pannomimimi/manifest.json` |

No channel was skipped or failed. Ten inspected candidate videos were not
accepted because no usable timestamp song source was parsed:

- `no_timestamp_candidates`: 5 videos
- `no_usable_song_source`: 5 videos

The affected video IDs are recorded in
`artifacts/channel-discovery/2026-07-21-single-source-pannomimimi/pannomimimi/audits.json`.

## Thumbnail coverage

Video thumbnail coverage is complete for this accepted increment:

- raw candidates missing `thumbnailUrl`: 0
- usable discovery details missing `thumbnailUrl`: 0
- accepted videos missing `thumbnailUrl`: 0

No global parser, cleanup, UI, or runtime rule changes were needed for this
channel. Channel avatar cache was not refreshed in this worker; runtime display
can still use the accepted video thumbnails as fallback if a real channel avatar
is not already cached.

## Artifacts

- Accepted increment: `data/external/youtube-channel-discovery/accepted/2026-07-21-pannomimimi-worker.json`
- Checkpoint: `artifacts/channel-discovery/2026-07-21-single-source-pannomimimi/pannomimimi/checkpoint.json`
- Raw candidates: `artifacts/channel-discovery/2026-07-21-single-source-pannomimimi/pannomimimi/raw-videos.json`
- Video details: `artifacts/channel-discovery/2026-07-21-single-source-pannomimimi/pannomimimi/video-details.json`
- Occurrence previews: `artifacts/channel-discovery/2026-07-21-single-source-pannomimimi/pannomimimi/occurrences.json`
- Audit details: `artifacts/channel-discovery/2026-07-21-single-source-pannomimimi/pannomimimi/audits.json`

## Local validation

Validation commands completed for this worker:

```powershell
node --test test/youtube-channel-discovery.test.js test/import-channel-discovery.test.js test/runtime-db.test.js
node --check scripts/youtube-channel-discovery.js
node --check scripts/youtube-channel-discovery-core.js
node --check scripts/export-channel-discovery-increment.js
```

Results:

- `node --test ...`: 16 tests passed.
- `node --check ...`: exit code 0 for all three checked scripts.
- JSON/export validation: `youtube:export-channel-increment` parsed the discovery
  artifacts and wrote the accepted increment with
  `CODEX_CHANNEL_DISCOVERY_INCREMENT_OK`.

DB dry-run attempts:

```powershell
npm run db:build -- --no-vsinger --output artifacts/runtime/song-rank-youtube-pannomimimi-check.sqlite
npm run db:build -- --no-vsinger --require-youtube-channel-discovery --limit-per-range 2000 --output artifacts/runtime/song-rank-youtube-pannomimimi-limited-check.sqlite
```

Both DB build attempts exceeded the local 10 minute command timeout without a
completion marker, so no DB probe result is claimed for this worker. The
remaining `.tmp` files from those two attempts were removed after stopping the
matching local child processes by output path.

This worker did not push, deploy, restart services, or rebuild production DB
runtime.
