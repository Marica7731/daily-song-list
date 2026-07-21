# Source backfill 2026-07-22 batch1

This is a partial small-batch source-backfill artifact. It does not refresh the full 1000+ channel estate and does not write to `data/external`.

## Accepted increment

- Final accepted increment: `artifacts\channel-discovery\2026-07-22-source-backfill-batch1\accepted\2026-07-22-source-backfill-batch1.accepted.json`
- Raw export before dirty audit: `artifacts\channel-discovery\2026-07-22-source-backfill-batch1\accepted\2026-07-22-source-backfill-batch1.raw-export.json`
- Export marker before dirty audit: `CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=2 readVideos=51 usableVideos=51 acceptedVideos=50 skippedRegressions=1 occurrences=809`
- Dirty audit: dropped 1 `ShirazunaIwo` non-song/member-only concert talk video; final accepted 49 videos, 808 occurrences, 485 unique songs.
- Time coverage: publishedTimestamp 49/49; occurrence time 808/808; occurrence seconds 808/808.
- Cover coverage: discovery manifests reported `MonicaMelodia` 4/4 and `ShirazunaIwo` 47/47; accepted JSON uses the existing exporter shape and does not carry `thumbnailUrl`.

## Status table

| Source | Status | Accepted videos | Occurrences | Unique songs | Time coverage | Cover coverage | Reason |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| `toamall` | failed | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | remote runner reached per-channel timeout before manifest |
| `UzakiLarme` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | assigned to batch1b but not completed before small-batch freeze |
| `AmakusaAroma` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | assigned to batch1b but not completed before small-batch freeze |
| `HimesakiYumeno` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | assigned to batch1b but not completed before small-batch freeze |
| `MonicaMelodia` | imported | 4 | 36 | 35 | published 4/4; time 36/36; seconds 36/36 | 4/4 | complete manifest imported into artifacts accepted increment |
| `ShirazunaIwo` | imported | 45 | 772 | 456 | published 45/45; time 772/772; seconds 772/772 | 47/47 | complete manifest imported into artifacts accepted increment; one non-song video dropped by dirty audit |
| `ChitaCh` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | assigned to batch1b but not completed before small-batch freeze |
| `arale_yumemita` | pending | 0 | 0 | 0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | assigned to batch1b but not completed before small-batch freeze |
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
| Videos | 6,174 | 6,217 | +43 |
| Songs | 27,336 | 27,514 | +178 |
| Occurrences | 98,058 | 98,810 | +752 |
| Source occurrences | 188,226 | 189,717 | +1,491 |
| Ranking rows | 119,605 | 120,134 | +529 |

Representative probes after rebuild:

- `MonicaMelodia`: before 1 video / 4 occurrences; after 3 videos / 27 occurrences.
- `ShirazunaIwo`: before 2 videos / 19 occurrences; after 44 videos / 764 occurrences.

## Remote cleanup

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch1b-vps3`: removed; `df -h /` => `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch1b-vps5`: removed; `df -h /` => `/dev/vda1 10G 2.6G 7.0G 27% /`.

## Commands

```powershell
npm run youtube:export-channel-increment -- --input-dir artifacts\channel-discovery\2026-07-22-source-backfill-batch1\remote-download\vps5\MonicaMelodia --input-dir artifacts\channel-discovery\2026-07-22-source-backfill-batch1\remote-download\vps5\ShirazunaIwo --output artifacts\channel-discovery\2026-07-22-source-backfill-batch1\accepted\2026-07-22-source-backfill-batch1.accepted.json
npm run db:build -- --no-vsinger --youtube-channel-discovery-dir artifacts\channel-discovery\youtube-discovery-before-20260722-batch1 --output artifacts\runtime\song-rank-youtube-before-20260722-batch1.sqlite
npm run db:build -- --no-vsinger --youtube-channel-discovery-dir artifacts\channel-discovery\youtube-discovery-after-20260722-batch1 --output artifacts\runtime\song-rank-youtube-after-20260722-batch1.sqlite
npm run db:probe -- --db artifacts\runtime\song-rank-youtube-after-20260722-batch1.sqlite --range all --view videos --q MonicaMelodia --page-size 3
npm run db:probe -- --db artifacts\runtime\song-rank-youtube-after-20260722-batch1.sqlite --range all --view videos --q ShirazunaIwo --page-size 3
```

No push, deployment, service restart, or production DB rebuild was done.
