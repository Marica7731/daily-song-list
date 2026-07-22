# 2026-07-22-source-backfill-batch18

This batch continues the bounded retry for `omaru_piano`. It does not modify `data/external`; it only writes an artifact-local accepted increment for the one completed shard after strict dirty audit.

## Status

| Source | Status | Shard | Candidates | Inspected | Accepted videos | Accepted occurrences | Dropped videos | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `https://www.youtube.com/@omaru_piano/streams` | partial | 1/4 completed | 148 | 37 | 8 | 34 | 6 | shard1 completed; shard0 failed with YouTube 429; shards2/3 pending |

## Accepted Increment

- Path: `artifacts/channel-discovery/2026-07-22-source-backfill-batch18/accepted-increment.json`.
- Stable input reference: `artifacts/channel-discovery/2026-07-22-source-backfill-batch18/candidate-increment-unfiltered.json`; remote download cache was removed after extraction.
- Accepted after dirty audit: 8 videos / 34 occurrences / 31 unique songs.
- Time coverage: publishedTimestamp 8/8; occurrence time 34/34; occurrence seconds 34/34.
- Cover coverage: discovery thumbnails 8/8; accepted increment thumbnail fields 0/8 because the export format does not carry thumbnail fields.
- Discovery shard1 coverage before audit: raw published 148/148; detail published 14/14; thumbnail 14/14.

## Dirty Audit

- Dropped 6 videos / 16 occurrences before export review.
- Hard drop terms: `フルート`, `生演奏`, `クラリネット`, `サックス`, `サクソフォン`, `sax`, `saxophone`.
- Exact phrase drops: `piano streaming`, `ピアノ演奏`.
- Suspicious-only terms: `live`, `ライブ`; suspicious videos without explicit singing context were not accepted in this batch.

## Remaining Work

- shard0 failed on vps3 after 4/144 inspected: YouTube HTTP 429.
- shards2/3 were not started in this batch to avoid compounding rate limits after the vps3 429.
- The source should not be marked fully imported until shards0/2/3 are completed or explicitly failed in later manifests.

## Remote Cleanup

- `vps3`: removed `/opt/ytb-song-rank-source-backfill-20260722-batch18-vps3`; `df -h` after cleanup: `/dev/sda1 99G 11G 88G 11% /`.
- `vps5`: removed `/opt/ytb-song-rank-source-backfill-20260722-batch18-vps5`; `df -h` after cleanup: `/dev/vda1 10G 2.6G 6.9G 28% /`.
