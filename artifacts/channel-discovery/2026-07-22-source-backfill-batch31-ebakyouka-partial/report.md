# 2026-07-22-source-backfill-batch31-ebakyouka-partial

This batch extracts a partial `ebakyouka` accepted increment from the previously committed vps3 checkpoint. It does not modify `data/external`; it only prepares an artifact-local increment for completed checkpoint details.

## Status

| Source | Status | Candidates | Inspected | Accepted videos | Accepted occurrences | Unique songs | Dropped videos | Reason |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `https://www.youtube.com/@ebakyouka/streams` | partial | 464 | 20 | 18 | 455 | 395 | 0 | exported completed checkpoint details only; remaining candidates pending |

## Accepted Increment

- Path: `artifacts/channel-discovery/2026-07-22-source-backfill-batch31-ebakyouka-partial/accepted-increment.json`.
- Stable input reference: `artifacts/channel-discovery/2026-07-22-source-backfill-batch31-ebakyouka-partial/candidate-increment-unfiltered.json`.
- Time coverage: publishedTimestamp 18/18; occurrence time 455/455; occurrence seconds 455/455.
- Cover coverage: accepted increment thumbnail fields 0/18; checkpoint detail thumbnails 18/18.

## Dirty Audit

- Dropped 0 videos / 0 occurrences.
- Suspicious retained videos: 0.
- Hard filter terms include flute/live-instrument and exact piano performance phrases; no hard instrument/performance-only title was imported in this partial batch.

## Remaining Work

- The earlier checkpoint covered 20/464 candidates and completed 18 video details.
- The rest of `ebakyouka` remains pending for a later sharded discovery batch.

## Remote Cleanup

- No new VPS was used for this extraction batch. It only reads the already committed checkpoint.
