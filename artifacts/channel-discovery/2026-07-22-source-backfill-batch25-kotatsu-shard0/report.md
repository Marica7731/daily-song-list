# 2026-07-22-source-backfill-batch25-kotatsu-shard0

This batch completes shard0 for `KOTATSUChHaruKotatsubutonclub` as a bounded source-backfill artifact. It does not modify `data/external`; it only writes an artifact-local accepted increment for review.

## Status

| Source | Status | Shard | Candidates | Inspected | Accepted videos | Accepted occurrences | Dropped videos | Reason |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `https://www.youtube.com/@KOTATSUChHaruKotatsubutonclub` | partial | 0/4 completed | 164 | 41 | 14 | 130 | 0 | shard0 completed; shards1/2/3 pending |

## Accepted Increment

- Path: `artifacts/channel-discovery/2026-07-22-source-backfill-batch25-kotatsu-shard0/accepted-increment.json`.
- Stable input reference: `artifacts/channel-discovery/2026-07-22-source-backfill-batch25-kotatsu-shard0/candidate-increment-unfiltered.json`; remote download cache was removed after extraction.
- Accepted after dirty audit: 14 videos / 130 occurrences / 128 unique songs.
- Time coverage: publishedTimestamp 14/14; occurrence time 130/130; occurrence seconds 130/130.
- Cover coverage: discovery thumbnails 14/14; accepted increment thumbnail fields 0/14.
- Discovery shard0 coverage before audit: raw published 164/164; detail published 14/14; reachedEnd=true.

## Dirty Audit

- Dropped 0 videos / 0 occurrences before export review.
- Suspicious 0 videos; broad `live` / `ライブ` hits are reviewed, not dropped blindly.
- All retained titles have explicit `弾き語り`, `歌枠`, or direct singing signals.

## Remaining Work

- shard0 is complete and accepted in this batch.
- shards1/2/3 remain pending for later batches.

## Remote Cleanup

- `vps5`: removed `/opt/ytb-song-rank-source-backfill-20260722-batch25-kotatsu-shard0-vps5`; `df -h` after cleanup: `/dev/vda1 10G 2.7G 6.9G 28% /`.
