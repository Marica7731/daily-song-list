# 2026-07-22-source-backfill-batch20

This batch continues the bounded retry for `omaru_piano`. It does not modify `data/external`; it only writes an artifact-local accepted increment for completed shard3 after strict dirty audit.

## Status

| Source | Status | Shard | Candidates | Inspected | Accepted videos | Accepted occurrences | Dropped videos | Reason |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `https://www.youtube.com/@omaru_piano/streams` | partial | 3/4 completed | 148 | 37 | 3 | 3 | 5 | shard3 completed; shard1/2 accepted in batches18/19; shard0 still failed with YouTube 429 |

## Accepted Increment

- Path: `artifacts/channel-discovery/2026-07-22-source-backfill-batch20/accepted-increment.json`.
- Stable input reference: `artifacts/channel-discovery/2026-07-22-source-backfill-batch20/candidate-increment-unfiltered.json`; remote download cache was removed after extraction.
- Accepted after dirty audit: 3 videos / 3 occurrences / 1 unique songs.
- Time coverage: publishedTimestamp 3/3; occurrence time 3/3; occurrence seconds 3/3.
- Cover coverage: discovery thumbnails 3/3; accepted increment thumbnail fields 0/3 because the export format does not carry thumbnail fields.
- Discovery shard3 coverage before audit: raw published 148/148; detail published 8/8; thumbnail 8/8.

## Dirty Audit

- Dropped 5 videos / 12 occurrences before export review.
- Hard drop terms: `フルート`, `生演奏`, `クラリネット`, `サックス`, `サクソフォン`, `sax`, `saxophone`.
- Exact phrase drops: `piano streaming`, `ピアノ演奏`.
- Contextual drops: `雑談`, `ピアノ演奏リレー` when the title frames the stream as instrument/performance/chat rather than singing.

## Remaining Work

- shard1 accepted increment is in batch18.
- shard2 accepted increment is in batch19.
- shard3 accepted increment is in this batch.
- shard0 remains unresolved after batch18 failed at 4/144 inspected with YouTube HTTP 429. The source should not be marked fully imported until shard0 is retried or explicitly failed in a later manifest.

## Remote Cleanup

- `vps5`: removed `/opt/ytb-song-rank-source-backfill-20260722-batch20-vps5`; `df -h` after cleanup: `/dev/vda1 10G 2.6G 6.9G 28% /`.
