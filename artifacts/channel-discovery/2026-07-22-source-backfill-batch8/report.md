# 2026-07-22 source backfill batch8

Scope: eighth small-batch commit for the 2026-07-22 requested source queue. This is not a full 1000+ channel rescan.

## Imported

| Channel | URL | Discovery videos/occurrences | Accepted videos/occurrences/songs | Time coverage | Thumbnail coverage | Elapsed | Notes |
| --- | --- | ---: | ---: | --- | --- | ---: | --- |
| NUROJUNK_OFFICIAL | https://www.youtube.com/@NUROJUNK_OFFICIAL | 8/74 | 7/61/60 | published 7/7; time 61/61; seconds 61/61 | 7/7 | 124s | accepted export skipped one existing regression; reachedEnd=true |
| Dia | https://www.youtube.com/@Dia-%E3%83%87%E3%82%A3%E3%82%A2 | 20/370 | 18/339/251 | published 18/18; time 339/339; seconds 339/339 | 18/18 | 346s | accepted export skipped two existing regressions; reachedEnd=true |
| KOKONEch_uv | https://www.youtube.com/@KOKONEch_uv/streams | 11/130 | 9/72/66 | published 9/9; time 72/72; seconds 72/72 | 9/9 | 464s | accepted export skipped two existing regressions; reachedEnd=true |

## Pending

| Channel | URL | Checkpoint | Reason |
| --- | --- | ---: | --- |
| AmanofuStella | https://www.youtube.com/@AmanofuStella | 18/235 candidates, details 9 | stopped after candidate count proved too large for this small-batch commit; continue or shard in a later unique batch |
| Kyoka_0609 | https://www.youtube.com/@Kyoka_0609 | 6/245 candidates, details 4 | stopped after candidate count proved too large for this small-batch commit; continue or shard in a later unique batch |
| kisaki | https://www.youtube.com/@%E5%A6%83%E7%8E%96-kisaki | 27/34 candidates, details 14 | stopped after three batch8 channels completed to keep this as a small-batch commit; continue in a later unique batch |

## Candidate Probe

| Channel | Candidates | reachedEnd |
| --- | ---: | --- |
| NUROJUNK_OFFICIAL | 10 | true |
| Dia | 27 | true |
| KOKONEch_uv | 30 | true |
| kisaki | 34 | true |
| KAMIKUMONONOA | 36 | true |
| hanaoto_youtube33 | 110 | true |
| UCnKt20HH_BiuID0FDHGMcvw | 115 | true |
| UCw0ty0mpHBx6xZt-K_hfNcA | 121 | true |
| omaru_piano | 147 | true |
| saclayui | 178 | true |
| UCrF92dEkXiTtexol0yg4Gmw | 233 | true |
| Laz_Furuto | 312 | true |

## Dirty Audit

- Dropped: 0 videos / 0 occurrences.
- Suspicious: 0 videos; term hits {}.
- Broad `live` / `ライブ` hits were reviewed manually and were not applied blindly.

## Local DB Verification

- Before: videos 6433, songs 28348, occurrences 102047, sourceOccurrences 195956, rankingRows 122635.
- After: videos 6465, songs 28440, occurrences 102498, sourceOccurrences 196814, rankingRows 122946.
- Delta: videos 32, songs 92, occurrences 451, sourceOccurrences 858, rankingRows 311.
- Channel probes: NUROJUNK 2/18 -> 7/57; Dia 2/28 -> 20/367; KOKONEch_uv 0/0 -> 9/72.

## Remote Cleanup

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch8-small-vps3`: removed; df `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch8-small-vps5`: removed; df `/dev/vda1 10G 2.6G 7.0G 27% /`.
- Candidate probe dirs cleaned: VPS3 df `/dev/sda1 99G 11G 89G 11% /`; VPS5 df `/dev/vda1 10G 2.6G 7.0G 27% /`.

## Remaining Queue

Status counts after this batch: {"failed": 1, "imported": 17, "pending": 18}.
Large or checkpointed channels such as `UtenHiyori`, `asaxmayo`, `Laz_Furuto`, `AmanofuStella`, `Kyoka_0609`, `KOTATSUChHaruKotatsubutonclub`, `KohanaLam`, `SoraOtoha`, `ebakyouka`, and `arale_yumemita` remain pending/failed for a later unique batch or shard run.
