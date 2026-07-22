# 2026-07-22 source backfill batch9

Scope: ninth small-batch commit for the 2026-07-22 requested source queue. This is not a full 1000+ channel rescan.

## Imported

| Channel | URL | Discovery videos/occurrences | Accepted videos/occurrences/songs | Time coverage | Thumbnail coverage | Elapsed | Notes |
| --- | --- | ---: | ---: | --- | --- | ---: | --- |
| kisaki | https://www.youtube.com/@%E5%A6%83%E7%8E%96-kisaki | 17/212 | 16/194/175 | published 16/16; time 194/194; seconds 194/194 | 16/16 | 376s | reachedEnd=true |
| KAMIKUMONONOA | https://www.youtube.com/@KAMIKUMONONOA | 14/176 | 14/176/172 | published 14/14; time 176/176; seconds 176/176 | 14/14 | 1794s | reachedEnd=true |

## Dirty Audit

- Dropped: 0 videos / 0 occurrences.
- Suspicious: 2 videos; term hits {"ライブ": 1, "live": 1}.
- Exact instrumental phrase filters were applied; broad `live` / `ライブ` hits were reviewed and were not dropped blindly.

## Local DB Verification

- Before: videos 6468, songs 28440, occurrences 102501, sourceOccurrences 196820, rankingRows 122949.
- After: videos 6497, songs 28559, occurrences 102876, sourceOccurrences 197563, rankingRows 123287.
- Delta: videos 29, songs 119, occurrences 375, sourceOccurrences 743, rankingRows 338.
- Channel probes: kisaki 1/19 -> 17/213; KAMIKUMONONOA 0/0 -> 13/167.

## Remote Cleanup

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch9-vps3`: removed; df `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch9-vps5`: removed; df `/dev/vda1 10G 2.6G 7.0G 27% /`.

## Remaining Queue

Status counts after this batch: {"failed": 1, "imported": 19, "pending": 16}.
Large or checkpointed channels such as `UtenHiyori`, `asaxmayo`, `Laz_Furuto`, `AmanofuStella`, `Kyoka_0609`, `KOTATSUChHaruKotatsubutonclub`, `KohanaLam`, `SoraOtoha`, `ebakyouka`, and `arale_yumemita` remain pending/failed for a later unique batch or shard run.
