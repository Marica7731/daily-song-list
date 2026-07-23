# Source Backfill Batch79 - hanaoto_youtube33

- Status: skipped
- Reason: skipped_duplicate
- Channel: https://www.youtube.com/@hanaoto_youtube33
- Branch confirmed read-only: codex/source-backfill-20260720-v2
- This worker did not run full-site discovery and did not write data/external.

## Duplicate Evidence

- Accepted file: artifacts\channel-discovery\2026-07-22-source-backfill-batch10\accepted\2026-07-22-source-backfill-batch10.accepted.json
- Manifest file: artifacts\channel-discovery\2026-07-22-source-backfill-batch10\manifest.json
- Dirty audit file: artifacts\channel-discovery\2026-07-22-source-backfill-batch10\dirty-audit.json
- Prior batch report: hanaoto_youtube33 imported with discovery videos/occurrences 58/889, accepted videos/occurrences/songs 4/49/38, elapsed 2226s, reachedEnd=true.

## Counts

| Metric | Value |
| --- | ---: |
| candidate count | 104 |
| inspected count | 104 |
| accepted videos this batch | 0 |
| accepted occurrences this batch | 0 |
| accepted unique songs this batch | 0 |
| duplicate accepted videos | 4 |
| duplicate accepted occurrences | 49 |
| duplicate accepted unique songs | 38 |
| duplicate dropped videos | 54 |
| duplicate dropped occurrences | 840 |
| duplicate suspicious videos | 4 |

## Coverage From Duplicate Accepted

- publishedTimestamp coverage: 4/4
- publishedTimestamp range: 2026-02-22T00:20:38.1250000Z to 2026-05-23T00:20:38.1250000Z
- occurrence time coverage: 49/49
- occurrence seconds coverage: 49/49
- thumbnail/cover coverage: 4/4
- reachedEnd: true

## Dirty Audit

Hard-drop rules recorded: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone.
Exact phrase drops recorded: piano streaming, piano performance, ピアノ演奏.
The live/ライブ rule is not a standalone hard drop; it is only suspicious/drop when no singing signal exists.

## Runtime And Cleanup

- This duplicate-skip run elapsed: 0s discovery time; no Mac discovery process started.
- Prior duplicate discovery elapsed: 2226s.
- Mac temp dir /Users/be/codex-temp/daily-song-list-source-backfill-batch79-hanaoto-youtube33-mac-readonly: not_present.
- Mac df -h summary:

```
CODEX_MAC_CLEANUP_STATUS=not_present
Filesystem        Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s1s1   926Gi    16Gi   594Gi     3%    458k  4.3G    0%   /
/dev/disk3s5     926Gi   295Gi   594Gi    34%    678k  6.2G    0%   /System/Volumes/Data
/dev/disk3s5     926Gi   295Gi   594Gi    34%    678k  6.2G    0%   /System/Volumes/Data
CODEX_MAC_DF_OK
```

- Windows D/C/G: no large cache, checkout, runtime DB, or source export was created. Only these five small artifact files were written in this batch artifact directory.

## Git And Delivery

- Commit: not run, per worker instruction.
- Push: not run, per worker instruction.
- Deploy/restart/package: not applicable and not run.
