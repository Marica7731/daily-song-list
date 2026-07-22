# 2026-07-22-source-backfill-batch19

This batch continues the bounded retry for `omaru_piano`. It does not modify `data/external`; it only writes an artifact-local accepted increment for completed shard2 after strict dirty audit.

## Status

| Source | Status | Shard | Candidates | Inspected | Accepted videos | Accepted occurrences | Dropped videos | Reason |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `https://www.youtube.com/@omaru_piano/streams` | partial | 2/4 completed | 148 | 37 | 6 | 22 | 5 | shard2 completed; shard0 failed in batch18; shard1 accepted in batch18; shard3 pending |

## Accepted Increment

- Path: `artifacts/channel-discovery/2026-07-22-source-backfill-batch19/accepted-increment.json`.
- Stable input reference: `artifacts/channel-discovery/2026-07-22-source-backfill-batch19/candidate-increment-unfiltered.json`; remote download cache was removed after extraction.
- Accepted after dirty audit: 6 videos / 22 occurrences / 20 unique songs.
- Time coverage: publishedTimestamp 6/6; occurrence time 22/22; occurrence seconds 22/22.
- Cover coverage: discovery thumbnails 6/6; accepted increment thumbnail fields 0/6 because the export format does not carry thumbnail fields.
- Discovery shard2 coverage before audit: raw published 148/148; detail published 11/11; thumbnail 11/11.

## Dirty Audit

- Dropped 5 videos / 16 occurrences before export review.
- Hard drop terms: `フルート`, `生演奏`, `クラリネット`, `サックス`, `サクソフォン`, `sax`, `saxophone`.
- Exact phrase drops: `piano streaming`, `ピアノ演奏`.
- Contextual drops: `合奏` when the title frames the stream as ensemble/performance rather than singing.
- Suspicious-only terms: `live`, `ライブ`; suspicious videos without explicit singing context were not accepted in this batch.

## Remaining Work

- shard0 failed in batch18 after 4/144 inspected: YouTube HTTP 429.
- shard1 accepted increment is in batch18.
- shard3 remains pending. The source should not be marked fully imported until shard3 and the shard0 gap are resolved or explicitly failed in later manifests.

## Remote Cleanup

- `vps5`: removed `/opt/ytb-song-rank-source-backfill-20260722-batch19-vps5`; `df -h` after cleanup: `/dev/vda1 10G 2.6G 6.9G 28% /`.
