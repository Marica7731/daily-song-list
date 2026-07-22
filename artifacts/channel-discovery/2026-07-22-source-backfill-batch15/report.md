# 2026-07-22 source backfill batch15

This batch attempted `asaxmayo` as four discovery shards. It does not contain an accepted increment and does not modify `data/external`.

## Status

| Source | Status | Shards | Accepted videos | Occurrences | Songs | Time coverage | Reason |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| `https://www.youtube.com/@asaxmayo/streams` | failed | 4 | 0 | 0 | 0 | `0/0` | no shard produced a complete discovery manifest |

## Shards

| Shard | Host | Status | Candidates | Inspected | Checkpoint usable videos | Elapsed | Reason |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `0/4` | `vps3` | failed | 571 | 90 | 49 | 3261s | YouTube HTTP 429 limit reached `(8/8)` |
| `1/4` | `vps5` | failed | 591 | 100 | 53 | 3601s | shard timeout before manifest |
| `2/4` | `vps3` | failed | 571 | 94 | 57 | 3221s | YouTube HTTP 429 limit reached `(8/8)` |
| `3/4` | `vps5` | failed | 591 | 106 | 58 | 3601s | shard timeout before manifest |

## Notes

- Candidate counts differed by host (`571` vs `591`) while fetching continuations. A later retry should use one stable candidate snapshot or a slower sequential resume path.
- Partial checkpoint details are not imported. This avoids treating interrupted or 429-limited output as a successful source.
- Recommended retry: lower concurrency, increase request interval, and resume/shard from checkpoint in a later unique batch.

## Remote Cleanup

- `vps3`: removed `/opt/ytb-song-rank-source-backfill-20260722-batch15-vps3`; `df -h` after cleanup: `/dev/sda1 99G 11G 88G 11% /`.
- `vps5`: removed `/opt/ytb-song-rank-source-backfill-20260722-batch15-vps5`; `df -h` after cleanup: `/dev/vda1 10G 2.6G 7.0G 28% /`.
