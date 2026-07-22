# 2026-07-22-source-backfill-batch29-kotatsu-consolidated

This batch consolidates all four completed `KOTATSUChHaruKotatsubutonclub` shard accepted increments. It does not modify `data/external`; it prepares one source-level artifact-local increment for integration review.

## Status

| Source | Status | Completed shards | Accepted videos | Accepted occurrences | Unique songs | Dropped videos | Duplicate videos |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| `https://www.youtube.com/@KOTATSUChHaruKotatsubutonclub` | imported_artifact_ready | 0/1/2/3 | 40 | 420 | 395 | 0 | 0 |

## Shards

| Shard | Batch | Videos | Occurrences | Songs | Dropped videos | Skipped regressions | Time/seconds coverage |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 2026-07-22-source-backfill-batch25-kotatsu-shard0 | 14 | 130 | 128 | 0 | 0 | 130/130; 130/130 |
| 1 | 2026-07-22-source-backfill-batch26-kotatsu-shard1 | 11 | 75 | 75 | 0 | 1 | 75/75; 75/75 |
| 2 | 2026-07-22-source-backfill-batch27-kotatsu-shard2 | 9 | 113 | 111 | 0 | 0 | 113/113; 113/113 |
| 3 | 2026-07-22-source-backfill-batch28-kotatsu-shard3 | 6 | 102 | 101 | 0 | 1 | 102/102; 102/102 |

## Coverage

- Published timestamp coverage: 40/40.
- Occurrence time coverage: 420/420.
- Occurrence seconds coverage: 420/420.
- Accepted thumbnail field coverage: 0/40.
- Export skipped existing regressions across shards: 2.
- Dirty audit dropped 0 videos / 0 occurrences; suspicious videos 1.

## Inputs

- `artifacts/channel-discovery/2026-07-22-source-backfill-batch25-kotatsu-shard0/accepted-increment.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch26-kotatsu-shard1/accepted-increment.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch27-kotatsu-shard2/accepted-increment.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch28-kotatsu-shard3/accepted-increment.json`

## Remote Cleanup

- No VPS used for this consolidation. Remote shard runners were cleaned in batches25, 26, 27, and 28.
