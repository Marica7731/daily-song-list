# 2026-07-22-source-backfill-batch27-kotatsu-shard2

This batch completes shard2 for `KOTATSUChHaruKotatsubutonclub` as a bounded source-backfill artifact. It does not modify `data/external`; it only writes an artifact-local accepted increment for review.

## Status

| Source | Status | Shard | Candidates | Inspected | Accepted videos | Accepted occurrences | Dropped videos | Reason |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `https://www.youtube.com/@KOTATSUChHaruKotatsubutonclub` | partial | 2/4 completed | 152 | 38 | 9 | 113 | 0 | shard2 completed; shard3 pending |

## Accepted Increment

- Path: `artifacts/channel-discovery/2026-07-22-source-backfill-batch27-kotatsu-shard2/accepted-increment.json`.
- Stable input reference: `artifacts/channel-discovery/2026-07-22-source-backfill-batch27-kotatsu-shard2/candidate-increment-unfiltered.json`; remote download cache was removed after extraction.
- Accepted after dirty audit: 9 videos / 113 occurrences / 111 unique songs.
- Export skipped existing regressions: 0.
- Time coverage: publishedTimestamp 9/9; occurrence time 113/113; occurrence seconds 113/113.
- Cover coverage: discovery thumbnails 9/9; accepted increment thumbnail fields 0/9.
- Discovery shard2 coverage before audit: raw published 152/152; detail published 9/9; reachedEnd=true.

## Dirty Audit

- Dropped 0 videos / 0 occurrences before export review.
- Suspicious 1 videos; `LIVE` was reviewed and accepted only where paired with original/song signals.
- Retained titles have explicit `弾き語り`, `歌ってみた`, `歌枠`, or direct original-song signals.

## Remaining Work

- shard0 accepted increment is in batch25.
- shard1 accepted increment is in batch26.
- shard2 is complete and accepted in this batch.
- shard3 remains pending for a later batch.

## Remote Cleanup

- `vps5`: removed `/opt/ytb-song-rank-source-backfill-20260722-batch27-kotatsu-shard2-vps5`; `df -h` after cleanup: `/dev/vda1 10G 2.7G 6.9G 28% /`.
