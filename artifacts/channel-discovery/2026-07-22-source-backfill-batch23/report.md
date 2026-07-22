# 2026-07-22-source-backfill-batch23

This batch retries `SoraOtoha` as a bounded shard after the previous full-run timeout. It does not modify `data/external`; it only writes an artifact-local accepted increment for completed shard2 after dirty audit.

## Status

| Source | Status | Shard | Candidates | Inspected | Accepted videos | Accepted occurrences | Dropped videos | Reason |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `https://www.youtube.com/@SoraOtoha` | partial | 2/4 completed | 127 | 32 | 26 | 496 | 0 | shard2 completed; shards0/1/3 pending |

## Accepted Increment

- Path: `artifacts/channel-discovery/2026-07-22-source-backfill-batch23/accepted-increment.json`.
- Stable input reference: `artifacts/channel-discovery/2026-07-22-source-backfill-batch23/candidate-increment-unfiltered.json`; remote download cache was removed after extraction.
- Accepted after dirty audit: 26 videos / 496 occurrences / 203 unique songs.
- Time coverage: publishedTimestamp 26/26; occurrence time 496/496; occurrence seconds 496/496.
- Cover coverage: discovery thumbnails 26/26; accepted increment thumbnail fields 0/26 because the export format does not carry thumbnail fields.
- Discovery shard2 coverage before audit: raw published 127/127; detail published 26/26; thumbnail 26/26.

## Dirty Audit

- Dropped 0 videos / 0 occurrences before export review.
- All retained titles have explicit `歌枠`, `歌枠リレー`, `弾き語り`, or direct singing signals.
- One title includes `雑談`, but it also explicitly says the stream starts with singing, so it remains accepted.

## Remaining Work

- Previous batch11 full-run attempt timed out at 64/127 inspected and produced no complete manifest for `SoraOtoha`.
- shard2 is now complete and accepted in this batch.
- shards0/1/3 remain pending for later batches.

## Remote Cleanup

- `vps5`: removed `/opt/ytb-song-rank-source-backfill-20260722-batch23-vps5`; `df -h` after cleanup: `/dev/vda1 10G 2.7G 6.9G 28% /`.
