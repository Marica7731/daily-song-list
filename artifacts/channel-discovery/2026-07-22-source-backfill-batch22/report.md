# 2026-07-22-source-backfill-batch22

This batch consolidates the four completed `omaru_piano` shard accepted increments. It does not modify `data/external`; it prepares one source-level artifact-local increment for integration review.

## Status

| Source | Status | Shards | Accepted videos | Accepted occurrences | Unique songs | Dropped videos | Duplicates |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| `https://www.youtube.com/@omaru_piano/streams` | imported_artifact_ready | 0/1/2/3 completed | 18 | 64 | 55 | 20 | 0 |

## Inputs

- shard0: `artifacts/channel-discovery/2026-07-22-source-backfill-batch21/accepted-increment.json`
- shard1: `artifacts/channel-discovery/2026-07-22-source-backfill-batch18/accepted-increment.json`
- shard2: `artifacts/channel-discovery/2026-07-22-source-backfill-batch19/accepted-increment.json`
- shard3: `artifacts/channel-discovery/2026-07-22-source-backfill-batch20/accepted-increment.json`

## Coverage

- publishedTimestamp: 18/18
- occurrence time: 64/64
- occurrence seconds: 64/64
- discovery thumbnail coverage: 18/18; accepted increment thumbnail fields: 0/18

## Dirty Audit

- Discovery before audit across shards: 38 videos / 128 occurrences.
- Dropped before consolidation: 20 videos / 64 occurrences.
- Consolidated accepted: 18 videos / 64 occurrences / 55 unique songs.
- Drop policy includes instrument/performance signals such as `フルート`, `生演奏`, `クラリネット`, `サックス`, `piano performance`, `ピアノ演奏`, `Session`, `合奏`, and `雑談`.

## Remote Cleanup

No VPS was used in this consolidation batch. The source batches being consolidated already recorded cleanup evidence:

- batch18: vps3 and vps5 cleaned.
- batch19: vps5 cleaned.
- batch20: vps5 cleaned.
- batch21: vps5 cleaned.
