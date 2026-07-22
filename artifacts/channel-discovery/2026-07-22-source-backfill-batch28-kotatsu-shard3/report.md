# 2026-07-22-source-backfill-batch28-kotatsu-shard3

This batch completes shard3 for `KOTATSUChHaruKotatsubutonclub` as a bounded source-backfill artifact. It does not modify `data/external`; it only writes an artifact-local accepted increment for review.

## Status

| Source | Status | Shard | Candidates | Inspected | Accepted videos | Accepted occurrences | Dropped videos | Reason |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `https://www.youtube.com/@KOTATSUChHaruKotatsubutonclub` | imported_partial_artifact | 3/4 completed | 147 | 36 | 6 | 102 | 0 | shard3 completed; all four shards now have artifact-local accepted increments |

## Accepted Increment

- Path: `artifacts/channel-discovery/2026-07-22-source-backfill-batch28-kotatsu-shard3/accepted-increment.json`.
- Stable input reference: `artifacts/channel-discovery/2026-07-22-source-backfill-batch28-kotatsu-shard3/candidate-increment-unfiltered.json`; remote download cache was removed after extraction.
- Accepted after dirty audit: 6 videos / 102 occurrences / 101 unique songs.
- Export skipped existing regressions: 1.
- Time coverage: publishedTimestamp 6/6; occurrence time 102/102; occurrence seconds 102/102.
- Cover coverage: discovery thumbnails 7/7; accepted increment thumbnail fields 0/6.
- Discovery shard3 coverage before audit: raw published 147/147; detail published 7/7; reachedEnd=true.

## Dirty Audit

- Dropped 0 videos / 0 occurrences before export review.
- Suspicious 0 videos.
- Retained titles have explicit `弾き語り`, `歌ってみた`, `歌枠`, or direct singing signals.

## Remaining Work

- shard0 accepted increment is in batch25.
- shard1 accepted increment is in batch26.
- shard2 accepted increment is in batch27.
- shard3 is complete and accepted in this batch.
- Next step: consolidate batches25/26/27/28 into one source-level artifact before integration review.

## Remote Cleanup

- `vps5`: removed `/opt/ytb-song-rank-source-backfill-20260722-batch28-kotatsu-shard3-vps5`; `df -h` after cleanup: `/dev/vda1 10G 2.7G 6.9G 28% /`.
