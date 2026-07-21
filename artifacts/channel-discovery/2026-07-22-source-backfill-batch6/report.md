# 2026-07-22 source backfill batch6

Scope: sixth small-batch commit for the 2026-07-22 requested source queue. This is not a full 1000+ channel rescan.

## Imported

| Channel | URL | Discovery videos/occurrences | Accepted videos/occurrences/songs | Time coverage | Thumbnail coverage | Elapsed | Notes |
| --- | --- | ---: | ---: | --- | --- | ---: | --- |
| RukaCh | https://www.youtube.com/@RukaCh.%E9%9B%A8%E6%B5%B7%E3%83%AB%E3%82%AB | 30/272 | 29/271/239 | published 29/29; time 271/271; seconds 271/271 | 29/29 | 689s | accepted export skipped existing regression `_zMnCDv-Tw4`; reachedEnd=true |
| inori_hw8 | https://www.youtube.com/@inori_hw8 | 26/313 | 26/313/185 | published 26/26; time 313/313; seconds 313/313 | 26/26 | 365s | reachedEnd=true |

## Dirty Audit

- Dropped: 0 videos / 0 occurrences.
- Suspicious: 9 videos; term hits {"live_en": 1, "live_ja": 8}.
- Broad `live` / `ライブ` hits were reviewed manually and were not applied blindly.

## Local DB Verification

- Before: videos 6357, songs 28132, occurrences 100661, sourceOccurrences 193220, rankingRows 122020.
- After: videos 6410, songs 28218, occurrences 101248, sourceOccurrences 194366, rankingRows 122352.
- Delta: videos 53, songs 86, occurrences 587, sourceOccurrences 1146, rankingRows 332.
- Channel probes: RukaCh handle query 3/89 -> 31/343; inori_hw8 query 1/17 -> 26/313.

## Remote Cleanup

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch6-vps3`: removed; df `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch6-vps5`: removed; df `/dev/vda1 10G 2.6G 7.0G 27% /`.

## Remaining Queue

Status counts after this batch: {"failed": 1, "imported": 13, "pending": 22}.
Large or checkpointed channels such as `ebakyouka`, `KohanaLam`, `SoraOtoha`, and `arale_yumemita` remain pending/failed for a later unique batch or shard run.
