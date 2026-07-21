# 2026-07-22 source backfill batch7

Scope: seventh small-batch commit for the 2026-07-22 requested source queue. This is not a full 1000+ channel rescan.

## Imported

| Channel | URL | Discovery videos/occurrences | Accepted videos/occurrences/songs | Time coverage | Thumbnail coverage | Elapsed | Notes |
| --- | --- | ---: | ---: | --- | --- | ---: | --- |
| Chiyutori | https://www.youtube.com/@Chiyutori | 28/967 | 27/909/459 | published 27/27; time 909/909; seconds 909/909 | 27/27 | 439s | accepted export skipped existing regression `XMTT-zzGBqw`; reachedEnd=true |

## Pending

| Channel | URL | Checkpoint | Reason |
| --- | --- | ---: | --- |
| KOTATSUChHaruKotatsubutonclub | https://www.youtube.com/@KOTATSUChHaruKotatsubutonclub | 24/151 candidates, details 11 | stopped after Chiyutori completed to keep this as a small-batch commit; continue or shard later |

## Dirty Audit

- Dropped: 0 videos / 0 occurrences.
- Suspicious: 3 videos; term hits {"live_ja": 2, "live_en": 1}.
- Broad `live` / `ライブ` hits were reviewed manually and were not applied blindly.

## Local DB Verification

- Before: videos 6410, songs 28218, occurrences 101248, sourceOccurrences 194366, rankingRows 122352.
- After: videos 6433, songs 28348, occurrences 102047, sourceOccurrences 195956, rankingRows 122635.
- Delta: videos 23, songs 130, occurrences 799, sourceOccurrences 1590, rankingRows 283.
- Channel probe: Chiyutori query 3/121 -> 26/920.

## Remote Cleanup

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch7-vps3`: removed; df `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch7-vps5`: removed; df `/dev/vda1 10G 2.6G 7.0G 27% /`.

## Remaining Queue

Status counts after this batch: {"failed": 1, "imported": 14, "pending": 21}.
Large or checkpointed channels such as `ebakyouka`, `KohanaLam`, `SoraOtoha`, `KOTATSUChHaruKotatsubutonclub`, and `arale_yumemita` remain pending/failed for a later unique batch or shard run.
