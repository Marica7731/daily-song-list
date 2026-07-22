# 2026-07-22-source-backfill-batch33-kyoka-shard0

This is a status-only stopped attempt for `https://www.youtube.com/@Kyoka_0609`. It does not modify `data/external` and does not provide an accepted increment.

## Status

| Source | Status | Shard | Candidates | Inspected | Checkpoint details | Accepted videos | Accepted occurrences | Reason |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `https://www.youtube.com/@Kyoka_0609` | failed | 0/4 | 164 | 32 | 31 | 0 | 0 | stopped before manifest/export/dirty-audit; no accepted artifact was produced |

## Remote Run

- Host: `vps-jp` (`VM-c8189ce8-42c5-4763-bfb1-d000d087dbb5`).
- Remote directory: `/opt/ytb-song-rank-source-backfill-20260722-batch33-kyoka-shard0-vps-jp`.
- Setup used remote sparse clone, not a large local tar upload.
- Command used an outer `timeout 3600s` around `npm run youtube:discover-channel` with `--inspect-shard-count 4 --inspect-shard-index 0`.
- Stop checkpoint at `2026-07-22T15:28:44Z`: candidateCount 164; inspectedInLatestRun 32; completedVideoIds 31; detailCount 31; updatedAt `2026-07-22T15:28:35Z`.
- No `manifest.json`, exported `video-details.json`, `accepted-increment.json`, or `dirty-audit.json` was retrieved.

## Cleanup

- Killed remote runner pids `561929/561931/561942/561943`; recheck showed they no longer existed.
- Removed the remote directory.
- Post-cleanup `df -h /`: `/dev/sda1 99G 27G 73G 27% /`.

## Remaining Work

Retry `Kyoka_0609` later with smaller shards or allow the bounded 3600s run to finish, then export only after manifest/video-details are available.
