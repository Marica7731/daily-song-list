# 2026-07-22-source-backfill-batch32-kohanalam-partial

This batch extracts a partial `KohanaLam` accepted increment from the previously committed vps3 checkpoint. It does not modify `data/external`; it only prepares an artifact-local increment for completed checkpoint details.

## Status

| Source | Status | Candidates | Inspected | Accepted videos | Accepted occurrences | Unique songs | Dropped videos | Reason |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `https://www.youtube.com/@KohanaLam/streams` | partial | 224 | 28 | 2 | 13 | 13 | 1 | exported completed checkpoint details only; remaining candidates pending |

## Accepted Increment

- Path: `artifacts/channel-discovery/2026-07-22-source-backfill-batch32-kohanalam-partial/accepted-increment.json`.
- Stable input reference: `artifacts/channel-discovery/2026-07-22-source-backfill-batch32-kohanalam-partial/candidate-increment-unfiltered.json`.
- Time coverage: publishedTimestamp 2/2; occurrence time 13/13; occurrence seconds 13/13.
- Cover coverage: accepted increment thumbnail fields 0/2; checkpoint detail thumbnails 2/2.

## Dirty Audit

- Dropped 1 videos / 2 occurrences.
- Suspicious retained videos: 0.
- Dropped `H5aQ0sId9CA`: official MV/Cover description timestamps are live-info schedule entries, not a song list

## Remaining Work

- The earlier checkpoint covered 28/224 candidates and completed 3 video details.
- The rest of `KohanaLam` remains pending for a later sharded discovery batch.

## Remote Cleanup

- No new VPS was used for this extraction batch. It only reads the already committed checkpoint.
