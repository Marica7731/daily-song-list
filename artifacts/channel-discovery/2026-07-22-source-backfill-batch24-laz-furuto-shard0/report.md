# 2026-07-22-source-backfill-batch24-laz-furuto-shard0

This batch attempted `Laz_Furuto` shard0 as a bounded retry. It does not modify `data/external` and does not produce an accepted increment because no complete discovery manifest was emitted.

## Status

| Source | Status | Shard | Candidates | Inspected | Checkpoint details | Accepted videos | Accepted occurrences | Reason |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `https://www.youtube.com/@Laz_Furuto/streams` | failed | 0/4 attempted | 312 | 69 | 21 | 0 | 0 | vps5 runner timed out after 3600 seconds before complete manifest |

## Coverage

- Accepted increment: not generated.
- Time coverage: publishedTimestamp `0/0`; occurrence time `0/0`; occurrence seconds `0/0`.
- Cover coverage: `0/0`.
- Dirty audit: not applied to an accepted increment because the discovery run did not finish.

## Evidence

- Local direct run failed before checkpoint with YouTube channel page `fetch failed`; this was retried on non-culua `vps5`.
- Remote attempt used `/opt/ytb-song-rank-source-backfill-20260722-batch24-laz-furuto-shard0-vps5`.
- Remote source commit: `7034fe29c57d386746389d61a09411b241539506`.
- Final remote summary: timeout after 3600 seconds, candidates 312, inspected 69, checkpoint details 21, no manifest.

## Cleanup

- `vps5`: removed `/opt/ytb-song-rank-source-backfill-20260722-batch24-laz-furuto-shard0-vps5`; `df -h` after cleanup: `/dev/vda1 10G 2.7G 6.9G 28% /`.

## Next

Retry with finer shards, for example splitting this source into 8 or 12 inspect shards, and only export accepted data after a complete manifest exists.
