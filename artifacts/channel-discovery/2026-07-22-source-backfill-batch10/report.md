# 2026-07-22 source backfill batch10

Scope: tenth small-batch commit for the 2026-07-22 requested source queue. This is not a full 1000+ channel rescan.

## Imported

| Channel | URL | Discovery videos/occurrences | Accepted videos/occurrences/songs | Time coverage | Thumbnail coverage | Elapsed | Notes |
| --- | --- | ---: | ---: | --- | --- | ---: | --- |
| hanaoto_youtube33 | https://www.youtube.com/@hanaoto_youtube33 | 58/889 | 4/49/38 | published 4/4; time 49/49; seconds 49/49 | 4/4 | 2226s | complete manifest imported after dirty audit; 54 flute/instrumental videos dropped before accepted increment; reachedEnd=true |
| UCnKt20HH_BiuID0FDHGMcvw | https://www.youtube.com/channel/UCnKt20HH_BiuID0FDHGMcvw | 99/1321 | 98/1312/767 | published 98/98; time 1312/1312; seconds 1312/1312 | 98/98 | 1384s | complete manifest imported into artifacts accepted increment; export skipped one existing regression video; reachedEnd=true |

## Dirty Audit

- Dropped: 54 videos / 840 occurrences.
- Suspicious: 5 videos; term hits {"flute": 54, "live": 57, "ライブ": 1}.
- Exact instrumental phrase filters were applied, including `フルート` and exact English `flute` hashtag/word matches seen in this channel. Broad `live` / `ライブ` hits were reviewed and were not dropped blindly.

## Local DB Verification

- Before: videos 6497, songs 28559, occurrences 102876, sourceOccurrences 197563, rankingRows 123287.
- After: videos 6598, songs 28903, occurrences 104216, sourceOccurrences 200074, rankingRows 124294.
- Delta: videos 101, songs 344, occurrences 1340, sourceOccurrences 2511, rankingRows 1007.
- Channel probes: hanaoto 0/0 -> 4/49; UCnKt20HH 2/31 -> 99/1322.

## Remote Cleanup

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch10-vps3`: removed; df `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch10-vps5`: removed; df `/dev/vda1 10G 2.6G 7.0G 27% /`.

## Remaining Queue

Status counts after this batch: {"failed": 1, "imported": 21, "pending": 14}.
Remaining larger or checkpointed channels such as `UCw0ty0mpHBx6xZt-K_hfNcA`, `omaru_piano`, `saclayui`, `UCrF92dEkXiTtexol0yg4Gmw`, `UtenHiyori`, `asaxmayo`, `Laz_Furuto`, `AmanofuStella`, `Kyoka_0609`, `KOTATSUChHaruKotatsubutonclub`, `KohanaLam`, `SoraOtoha`, `ebakyouka`, and `arale_yumemita` remain pending/failed for later unique batches or shard runs.
