# 2026-07-22-source-backfill-batch21

This batch retries the previous `omaru_piano` shard0 gap with a lower-rate single-host runner. It does not modify `data/external`; it only writes an artifact-local accepted increment for completed shard0 after strict dirty audit.

## Status

| Source | Status | Shard | Candidates | Inspected | Accepted videos | Accepted occurrences | Dropped videos | Reason |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `https://www.youtube.com/@omaru_piano/streams` | imported_partial_artifact | 0/4 completed | 148 | 37 | 1 | 5 | 4 | shard0 completed on vps5; previous batch18 429 gap resolved |

## Accepted Increment

- Path: `artifacts/channel-discovery/2026-07-22-source-backfill-batch21/accepted-increment.json`.
- Stable input reference: `artifacts/channel-discovery/2026-07-22-source-backfill-batch21/candidate-increment-unfiltered.json`; remote download cache was removed after extraction.
- Accepted after dirty audit: 1 video / 5 occurrences / 5 unique songs.
- Time coverage: publishedTimestamp 1/1; occurrence time 5/5; occurrence seconds 5/5.
- Cover coverage: discovery thumbnails 1/1; accepted increment thumbnail fields 0/1 because the export format does not carry thumbnail fields.
- Discovery shard0 coverage before audit: raw published 148/148; detail published 5/5; thumbnail 5/5.

## Dirty Audit

- Dropped 4 videos / 20 occurrences before export review.
- Hard drop terms: `フルート`, `生演奏`, `クラリネット`, `サックス`, `サクソフォン`, `sax`, `saxophone`.
- Exact phrase drops: `piano streaming`, `piano performance`, `ピアノ演奏`.
- Contextual drops: `Session`, `セッション` when the title frames the stream as instrument/performance rather than a clear singing frame.

## Remaining Work

- `omaru_piano` shard0 completed in this batch.
- `omaru_piano` shard1 accepted increment is in batch18.
- `omaru_piano` shard2 accepted increment is in batch19.
- `omaru_piano` shard3 accepted increment is in batch20.
- Integration should merge these four artifact-local increments deliberately; this batch still does not write `data/external`.

## Remote Cleanup

- `vps5`: removed `/opt/ytb-song-rank-source-backfill-20260722-batch21-vps5`; `df -h` after cleanup: `/dev/vda1 10G 2.6G 6.9G 28% /`.
