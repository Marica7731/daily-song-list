# Source backfill 2026-07-22 batch2

This is a partial small-batch source-backfill artifact. It does not refresh the full 1000+ channel estate and does not write to `data/external`.

## Accepted increment

- Final accepted increment: `artifacts\channel-discovery\2026-07-22-source-backfill-batch2\accepted\2026-07-22-source-backfill-batch2.accepted.json`
- Raw export before dirty audit: `artifacts\channel-discovery\2026-07-22-source-backfill-batch2\accepted\2026-07-22-source-backfill-batch2.raw-export.json`
- Export marker before dirty audit: `CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=3 readVideos=36 usableVideos=36 acceptedVideos=36 skippedRegressions=0 occurrences=358`
- Dirty audit: dropped 2 `UzakiLarme` rows whose only parsed occurrence was unrelated `Santo Rosário / Live Ao vivo` description text.
- Final accepted totals: 34 videos, 356 occurrences, 313 unique songs.
- Time coverage: publishedTimestamp 34/34; occurrence time 356/356; occurrence seconds 356/356.

## Status table

| Source | Status | Accepted videos | Occurrences | Unique songs | Time coverage | Cover coverage | Reason |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| `toamall` | imported | 9 | 104 | 90 | published 9/9; time 104/104; seconds 104/104 | 9/9 | complete manifest imported into artifacts accepted increment |
| `UzakiLarme` | imported | 23 | 238 | 213 | published 23/23; time 238/238; seconds 238/238 | 25/25 | complete manifest imported into artifacts accepted increment |
| `AmakusaAroma` | imported | 2 | 14 | 14 | published 2/2; time 14/14; seconds 14/14 | 2/2 | complete manifest imported into artifacts accepted increment |
| `HimesakiYumeno` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | checkpoint reached 29/81 when batch was frozen for small commit; rerun in next batch |
| `MonicaMelodia` | imported | 4 | 36 | 35 | published 4/4; time 36/36; seconds 36/36 | 4/4 | complete manifest imported into artifacts accepted increment |
| `ShirazunaIwo` | imported | 45 | 772 | 456 | published 45/45; time 772/772; seconds 772/772 | 47/47 | complete manifest imported into artifacts accepted increment; one non-song video dropped by dirty audit |
| `ChitaCh` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | assigned after HimesakiYumeno but not started before small-batch freeze |
| `arale_yumemita` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | assigned after HimesakiYumeno but not started before small-batch freeze |
| `UCrF92dEkXiTtexol0yg4Gmw` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `Kamisatoniina` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `KohanaLam` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `sakisakatsumugi` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `SoraOtoha` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `rayray_429` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `ebakyouka` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `Chiyutori` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `irorinaru` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `RukaCh` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `inori_hw8` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `KOTATSUChHaruKotatsubutonclub` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `AmanofuStella` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `Kyoka_0609` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `UCw0ty0mpHBx6xZt-K_hfNcA` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `kisaki` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `Dia` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `NUROJUNK_OFFICIAL` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `UCnKt20HH_BiuID0FDHGMcvw` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `UtenHiyori` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `HazukiHina` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `asaxmayo` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `Laz_Furuto` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `hanaoto_youtube33` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `saclayui` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `omaru_piano` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `KAMIKUMONONOA` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |
| `KOKONEch_uv` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued for a later unique batch; not started in this committed batch |

## DB verification

Local YouTube-only builds with `--no-vsinger` were used only to verify this artifact set.

| Metric | Before | After | Delta |
| --- | ---: | ---: | ---: |
| Videos | 6,217 | 6,249 | +32 |
| Songs | 27,514 | 27,742 | +228 |
| Occurrences | 98,810 | 99,180 | +370 |
| Source occurrences | 189,717 | 190,312 | +595 |
| Ranking rows | 120,134 | 120,584 | +450 |

Representative probes after rebuild:

- `toamall`: 9 videos / 104 occurrences.
- `UzakiLarme`: 23 videos / 238 occurrences.
- `AmakusaAroma`: 2 videos / 14 occurrences.

## Remote cleanup

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch2-vps3`: removed; `df -h /` => `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch2-vps5`: removed; `df -h /` => `/dev/vda1 10G 2.6G 7.0G 27% /`.

No push, deployment, service restart, or production DB rebuild was done.
