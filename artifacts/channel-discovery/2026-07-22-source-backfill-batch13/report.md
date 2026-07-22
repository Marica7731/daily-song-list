# 2026-07-22 source backfill batch13

This batch only records bounded-runner failure checkpoints. It does not contain an accepted increment and does not modify `data/external`.

## Status

| Source | Status | Candidates | Inspected | Accepted videos | Occurrences | Songs | Time coverage | Reason |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `https://www.youtube.com/@KOTATSUChHaruKotatsubutonclub` | failed | 134 | 130 | 0 | 0 | 0 | `0/0` | remote timeout after 2700s before complete manifest |
| `https://www.youtube.com/channel/UCrF92dEkXiTtexol0yg4Gmw` | failed | 306 | 135 | 0 | 0 | 0 | `0/0` | remote timeout after 2700s before complete manifest |

## Evidence

- Remote source commit: `64bad38907ec92d72c602fe7c37ae952dc650ade`.
- `vps3` runner wrote a checkpoint and final status for `KOTATSUChHaruKotatsubutonclub`: `exitCode=-9`, `timedOut=true`, `hasManifest=false`, `hasCheckpoint=true`, `candidateCount=134`, `inspectedInLatestRun=130`.
- `vps5` runner wrote a checkpoint and final status for `UCrF92dEkXiTtexol0yg4Gmw`: `exitCode=-9`, `timedOut=true`, `hasManifest=false`, `hasCheckpoint=true`, `candidateCount=306`, `inspectedInLatestRun=135`.
- Both channels had `usableVideoCount=0` at timeout, but this is not treated as a completed no-match result because neither run reached the end or emitted a complete manifest.

## Dirty Audit Policy

The batch kept the current instrument/non-song-frame screen:

- Drop indicators: `フルート`, `生演奏`, `クラリネット`, `サックス`, `サクソフォン`, `sax`, `saxophone`.
- Exact phrase drops: `piano streaming`, `ピアノ演奏`.
- Suspicious-only indicators: `live`, `ライブ`.

## Next Action

Resume or shard both sources from checkpoint. Do not mark either source as imported/skipped until a complete manifest exists.

## Remote Cleanup

- `vps3`: removed `/opt/ytb-song-rank-source-backfill-20260722-batch13-vps3`; `df -h` after cleanup: `/dev/sda1 99G 11G 88G 11% /`.
- `vps5`: removed `/opt/ytb-song-rank-source-backfill-20260722-batch13-vps5`; `df -h` after cleanup: `/dev/vda1 10G 2.6G 7.0G 28% /`.
