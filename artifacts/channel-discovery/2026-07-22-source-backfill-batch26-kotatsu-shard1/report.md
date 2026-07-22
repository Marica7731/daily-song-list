# 2026-07-22-source-backfill-batch26-kotatsu-shard1

This batch completes shard1 for `KOTATSUChHaruKotatsubutonclub` as a bounded source-backfill artifact. It does not modify `data/external`; it only writes an artifact-local accepted increment for review.

## Status

| Source | Status | Shard | Candidates | Inspected | Accepted videos | Accepted occurrences | Dropped videos | Reason |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `https://www.youtube.com/@KOTATSUChHaruKotatsubutonclub` | partial | 1/4 completed | 156 | 39 | 11 | 75 | 0 | shard1 completed; shards2/3 pending |

## Accepted Increment

- Path: `artifacts/channel-discovery/2026-07-22-source-backfill-batch26-kotatsu-shard1/accepted-increment.json`.
- Stable input reference: `artifacts/channel-discovery/2026-07-22-source-backfill-batch26-kotatsu-shard1/candidate-increment-unfiltered.json`; remote download cache was removed after extraction.
- Accepted after dirty audit: 11 videos / 75 occurrences / 75 unique songs.
- Export skipped existing regressions: 1.
- Time coverage: publishedTimestamp 11/11; occurrence time 75/75; occurrence seconds 75/75.
- Cover coverage: discovery thumbnails 12/12; accepted increment thumbnail fields 0/11.
- Discovery shard1 coverage before audit: raw published 156/156; detail published 12/12; reachedEnd=true.

## Dirty Audit

- Dropped 0 videos / 0 occurrences before export review.
- Suspicious 0 videos; broad `live` / `ライブ` hits are reviewed, not dropped blindly.
- All retained titles have explicit `弾き語り`, `歌枠`, or direct singing signals.

## Remaining Work

- shard0 accepted increment is in batch25.
- shard1 is complete and accepted in this batch.
- shards2/3 remain pending for later batches.

## Remote Cleanup

- `vps5`: removed `/opt/ytb-song-rank-source-backfill-20260722-batch26-kotatsu-shard1-vps5`; `df -h` after cleanup: `/dev/vda1 10G 2.7G 6.9G 28% /`.
