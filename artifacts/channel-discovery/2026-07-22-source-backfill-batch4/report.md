# Source backfill 2026-07-22 batch4

This is a partial small-batch source-backfill artifact. It does not refresh the full 1000+ channel estate and does not write to `data/external`.

## Accepted increment

- Final accepted increment: `artifacts\channel-discovery\2026-07-22-source-backfill-batch4\accepted\2026-07-22-source-backfill-batch4.accepted.json`
- Raw export before dirty audit: `artifacts\channel-discovery\2026-07-22-source-backfill-batch4\accepted\2026-07-22-source-backfill-batch4.raw-export.json`
- Export marker before dirty audit: `CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=2 readVideos=41 usableVideos=41 acceptedVideos=41 skippedRegressions=0 occurrences=550`
- Dirty audit: dropped 0 videos / 0 occurrences; suspicious 0 retained.
- Final accepted totals: 41 videos, 550 occurrences, 309 unique songs.
- Time coverage: publishedTimestamp 41/41; occurrence time 550/550; occurrence seconds 550/550.

## Status table

| Source | Status | Accepted videos | Occurrences | Unique songs | Time coverage | Cover coverage | Reason |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| `toamall` | imported | 9 | 104 | 90 | published 9/9; time 104/104; seconds 104/104 | 9/9 | complete manifest imported into artifacts accepted increment |
| `UzakiLarme` | imported | 23 | 238 | 213 | published 23/23; time 238/238; seconds 238/238 | 25/25 | complete manifest imported into artifacts accepted increment |
| `AmakusaAroma` | imported | 2 | 14 | 14 | published 2/2; time 14/14; seconds 14/14 | 2/2 | complete manifest imported into artifacts accepted increment |
| `HimesakiYumeno` | imported | 52 | 698 | 471 | published 52/52; time 698/698; seconds 698/698 | 52/52 | complete manifest imported into artifacts accepted increment |
| `MonicaMelodia` | imported | 4 | 36 | 35 | published 4/4; time 36/36; seconds 36/36 | 4/4 | complete manifest imported into artifacts accepted increment |
| `ShirazunaIwo` | imported | 45 | 772 | 456 | published 45/45; time 772/772; seconds 772/772 | 47/47 | complete manifest imported into artifacts accepted increment; one non-song video dropped by dirty audit |
| `ChitaCh` | imported | 16 | 181 | 156 | published 16/16; time 181/181; seconds 181/181 | 16/16 | complete manifest imported into artifacts accepted increment |
| `arale_yumemita` | failed | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | remote runner reached per-channel timeout before manifest; checkpoint preserved for retry; failure: Timed out after 1200 seconds; checkpoint inspected 96/186 candidates; no accepted manifest was generated |
| `UCrF92dEkXiTtexol0yg4Gmw` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | batch was frozen after earlier channel timeout; not committed as success; retry/shard in later unique batch |
| `Kamisatoniina` | imported | 22 | 327 | 179 | published 22/22; time 327/327; seconds 327/327 | 22/22 | complete manifest imported into artifacts accepted increment |
| `KohanaLam` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | remote runner was stopped for small-batch commit after checkpoint; continue in later batch; failure: checkpoint inspected 28/224 candidates; no complete manifest committed |
| `sakisakatsumugi` | imported | 19 | 223 | 130 | published 19/19; time 223/223; seconds 223/223 | 19/19 | complete manifest imported into artifacts accepted increment |
| `SoraOtoha` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | remote runner was stopped for small-batch commit after checkpoint; continue in later batch; failure: checkpoint inspected 14/126 candidates; no complete manifest committed |
| `rayray_429` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | queued behind SoraOtoha on VPS5 and not started before small-batch stop |
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
| Videos | 6,314 | 6,348 | +34 |
| Songs | 27,913 | 28,029 | +116 |
| Occurrences | 100,012 | 100,505 | +493 |
| Source occurrences | 191,933 | 192,912 | +979 |
| Ranking rows | 121,179 | 121,661 | +482 |

Representative probes after rebuild:

- `Kamisatoniina`: 21 videos / 320 occurrences.
- `sakisakatsumugi`: 16 videos / 202 occurrences.

## Remote cleanup

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch4-vps3`: removed; `df -h /` => `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch4-vps5`: removed; `df -h /` => `/dev/vda1 10G 2.6G 7.0G 27% /`.

No push, deployment, service restart, or production DB rebuild was done.
