# Source backfill 2026-07-20

This run is a scoped YouTube source backfill, not a full refresh of every channel on the site. The completed wave covers the 14 originally requested sources plus the user-added `Tamamachi_Pue` and `asuyumekanae`, 16 sources total. A later 16-source batch is recorded at the end of this document as queued follow-up work.

Skipped-source correction: the earlier wave tables used online API samples as skipped evidence for some channels. That is not a valid skipped standard. A requested source is skipped only when VSinger Moment already covers it or when a manually reviewed import is complete and verifiable for that source. Online API rows with a small `videoCount` or `occurrenceCount` are not enough; those sources must be rerun through channel discovery.

## Branch and inputs

- Clone: `D:\Projects\daily_song_list_worker_source_backfill_20260720`
- Branch: `codex/source-backfill-20260720-v2`
- Initial base: `560ca0956fdd1f3f8d6bc4fe3bc005d9a8a60ae5`
- Latest fetched `origin/main` during verification: `6afbad99b37b0ef2b11b679a7b4b315d98d37964`
- Accepted increment: `data/external/youtube-channel-discovery/accepted/2026-07-20-source-backfill-wave1.json`
- Increment totals: 13 discovery input dirs, 545 video details read, 451 accepted videos, 6,738 accepted occurrences, 94 duplicate video IDs deduped across shards, 0 regression skips.
- Time coverage in accepted increment: video `publishedTimestamp` 451/451; occurrence `time` or `seconds` 6,738/6,738.

## Discovery script changes

- `scripts/youtube-channel-discovery-core.js`
  - Allows deterministic inspect sharding with `--inspect-shard-index` and `--inspect-shard-count`.
  - Retries transient YouTube continuation JSON failures, including `terminated`.
  - Uses local normalized hashing so discovery can run in sparse checkout without loading the full curation stack.
  - Falls back to the requested channel URL and singer name when YouTube page metadata omits channel handle/name.
- `scripts/import-channel-discovery.js`
  - Backfills channel name, handle, and channel ID inside each export/import batch so partially missing YouTube metadata does not split one channel into multiple vtuber rows.
  - Normalizes `/@handle/streams` to `/@handle`.

## Completed wave status

Online skipped evidence was refreshed from `https://ytb-song-rank.culua.com/api/meta` and `/api/rankings` at `2026-07-20T00:07:52Z`. The production source at that time was `6afbad99b37b0ef2b11b679a7b4b315d98d37964`, built at `2026-07-19T23:49:16Z`.

| Source | Status | Evidence |
| --- | --- | --- |
| `https://www.youtube.com/@Sen_44` | imported | candidates 42; inspected 37; accepted videos 33; accepted occurrences 701; unique songs 447; raw publishedAt 42/42; detail publishedTimestamp 33/33; occurrence time 701/701; reachedEnd true |
| `https://www.youtube.com/@HazukiHina` | imported | initial run hit undici `terminated`; retried after continuation JSON retry fix. candidates 12; inspected 11; accepted videos 7; accepted occurrences 51; unique songs 45; raw publishedAt 12/12; detail publishedTimestamp 7/7; occurrence time 51/51; reachedEnd true |
| `https://www.youtube.com/@karakurinne` | skipped | already online: videos 5; occurrences 45; top video `EgXZfGkfexE`; sample publishedTimestamp 2/2 |
| `https://www.youtube.com/@Otokado_Ruki` | skipped | already online: videos 2; occurrences 21; top video `AWIAAcxBhgg`; sample publishedTimestamp 2/2 |
| `https://www.youtube.com/@itk_tks` | skipped | already online: videos 4; occurrences 50; top video `L9Qgz6Z_dDg`; sample publishedTimestamp 2/2 |
| `https://www.youtube.com/@YuNivirtualsinger` | imported | candidates 96; inspected 96; accepted videos 46; accepted occurrences 64; unique songs 63; raw publishedAt 96/96; detail publishedTimestamp 46/46; occurrence time 64/64; reachedEnd true |
| `https://www.youtube.com/@SHALOYAMADA-Vsinger` | imported | candidates 24; inspected 24; accepted videos 10; accepted occurrences 157; unique songs 127; raw publishedAt 10/24; detail publishedTimestamp 10/10; occurrence time 157/157; reachedEnd true |
| `https://www.youtube.com/@Stratia113` | skipped | already online: videos 2; occurrences 13; top video `Q0qPh3vIZk4`; sample publishedTimestamp 2/2 |
| `https://www.youtube.com/@irorinaru` | imported | candidates 42; inspected 42; accepted videos 8; accepted occurrences 30; unique songs 28; raw publishedAt 42/42; detail publishedTimestamp 8/8; occurrence time 30/30; reachedEnd true |
| `https://www.youtube.com/@perucia_ten` | skipped | already online: videos 2; occurrences 28; top video `C41DcY1GIqo`; sample publishedTimestamp 2/2 |
| `https://www.youtube.com/@suzuna_subaru` | imported | candidates 69; inspected 69; accepted videos 48; accepted occurrences 390; unique songs 268; raw publishedAt 69/69; detail publishedTimestamp 48/48; occurrence time 390/390; reachedEnd true |
| `https://www.youtube.com/@UtagawaLetora/streams` | imported | candidates 52; inspected 52; accepted videos 22; accepted occurrences 95; unique songs 89; raw publishedAt 52/52; detail publishedTimestamp 22/22; occurrence time 95/95; reachedEnd true |
| `https://www.youtube.com/@SuzuhanaInori` | imported | candidates 51; inspected 51; accepted videos 49; accepted occurrences 1,138; unique songs 565; raw publishedAt 51/51; detail publishedTimestamp 49/49; occurrence time 1,138/1,138; reachedEnd true |
| `https://www.youtube.com/@HoshiHo_HsH` | skipped | already online: videos 2; occurrences 65; top video `3EqUkBPOVrY`; sample publishedTimestamp 2/2 |
| `https://www.youtube.com/@Tamamachi_Pue` | imported | candidates 58; inspected 58; accepted videos 40; accepted occurrences 452; unique songs 360; raw publishedAt 58/58; detail publishedTimestamp 40/40; occurrence time 452/452; reachedEnd true |
| `https://www.youtube.com/@asuyumekanae` | imported | sharded across local, VPS3, and VPS5. candidates 456; inspected 445; shard usable videos 282 before duplicate removal; accepted videos 188; accepted occurrences 3,660; unique songs 1,374; raw publishedAt 456/456; detail publishedTimestamp 282/282; occurrence time 3,660/3,660; reachedEnd true |

## Skipped-source rerun batch 1

Batch 1 corrects six first-wave rows that were previously marked skipped from weak online API evidence. All six were rerun locally in `D:\Projects\daily_song_list_worker_skipped_source_rerun_20260720` on branch `codex/skipped-source-rerun-20260720`; no VPS was used for this batch.

- Accepted increment: `data/external/youtube-channel-discovery/accepted/2026-07-20-skipped-source-rerun-batch1.json`
- Increment totals: 6 discovery input dirs, 555 video details read, 555 accepted videos, 8,039 accepted occurrences, 0 duplicate video IDs, 0 regression skips.
- Time coverage in accepted increment: video `publishedTimestamp` 555/555; occurrence `time` or `seconds` 8,039/8,039.
- Superseded skipped evidence: the old `already online` rows for the six sources below should be ignored after this batch.

| Source | Status | Evidence |
| --- | --- | --- |
| `https://www.youtube.com/@karakurinne` | imported | candidates 24; inspected 24; accepted videos 22; accepted occurrences 224; unique songs 200; raw publishedAt 24/24; detail publishedTimestamp 22/22; occurrence time 224/224; reachedEnd true |
| `https://www.youtube.com/@Otokado_Ruki` | imported | candidates 227; inspected 227; accepted videos 179; accepted occurrences 1,933; unique songs 769; raw publishedAt 227/227; detail publishedTimestamp 179/179; occurrence time 1,933/1,933; reachedEnd true |
| `https://www.youtube.com/@itk_tks` | imported | candidates 319; inspected 319; accepted videos 281; accepted occurrences 4,619; unique songs 701; raw publishedAt 319/319; detail publishedTimestamp 281/281; occurrence time 4,619/4,619; reachedEnd true |
| `https://www.youtube.com/@Stratia113` | imported | candidates 19; inspected 19; accepted videos 19; accepted occurrences 144; unique songs 141; raw publishedAt 19/19; detail publishedTimestamp 19/19; occurrence time 144/144; reachedEnd true |
| `https://www.youtube.com/@perucia_ten` | imported | candidates 8; inspected 8; accepted videos 7; accepted occurrences 82; unique songs 78; raw publishedAt 8/8; detail publishedTimestamp 7/7; occurrence time 82/82; reachedEnd true |
| `https://www.youtube.com/@HoshiHo_HsH` | imported | candidates 59; inspected 59; accepted videos 47; accepted occurrences 1,037; unique songs 864; raw publishedAt 59/59; detail publishedTimestamp 47/47; occurrence time 1,037/1,037; reachedEnd true |

## Skipped-source rerun batch 2

Batch 2 continues the skipped-source correction with complete local manifests for five more sources. `delutaya` hit `TypeError: fetch failed` during watch-page inspection and is intentionally not included in this accepted increment. `akari0415` and `nanashi_77shi` were not started in this batch.

- Accepted increment: `data/external/youtube-channel-discovery/accepted/2026-07-20-skipped-source-rerun-batch2.json`
- Increment totals: 5 discovery input dirs, 539 usable video details read, 537 accepted videos, 4,824 accepted occurrences, 2 regression skips.
- Time coverage in accepted increment: video `publishedTimestamp` 537/537; occurrence `time` or `seconds` 4,824/4,824.
- Regression skips: 2 videos were skipped because existing catalog data had richer song lists than the refreshed discovery result.

| Source | Status | Evidence |
| --- | --- | --- |
| `https://www.youtube.com/@nemgorochan` | imported | manifest candidates 402; inspected 402; usable videos 167; manifest occurrences 1,681; accepted videos 167; accepted occurrences 1,679; unique songs 795; accepted publishedTimestamp 167/167; accepted occurrence time 1,679/1,679; reachedEnd true |
| `https://www.youtube.com/@kohigashihitona` | imported | manifest candidates 199; inspected 199; usable videos 185; manifest occurrences 1,738; accepted videos 184; accepted occurrences 1,728; unique songs 851; accepted publishedTimestamp 184/184; accepted occurrence time 1,728/1,728; reachedEnd true |
| `https://www.youtube.com/@TsumugiCarla` | imported | manifest candidates 193; inspected 193; usable videos 140; accepted videos 140; accepted occurrences 1,126; unique songs 322; accepted publishedTimestamp 140/140; accepted occurrence time 1,126/1,126; reachedEnd true |
| `https://www.youtube.com/@HONKTHEHORN_OFFICIAL` | imported | manifest candidates 22; inspected 22; usable videos 17; accepted videos 17; accepted occurrences 164; unique songs 132; accepted publishedTimestamp 17/17; accepted occurrence time 164/164; reachedEnd true |
| `https://www.youtube.com/@Mei-Mei2024` | imported | manifest candidates 90; inspected 90; usable videos 30; manifest occurrences 129; accepted videos 29; accepted occurrences 127; unique songs 114; accepted publishedTimestamp 29/29; accepted occurrence time 127/127; reachedEnd true |
| `https://www.youtube.com/@delutaya` | pending | checkpoint exists; latest run stopped at `TypeError: fetch failed`; not exported and not counted as imported |
| `https://www.youtube.com/@akari0415` | pending | not started in this skipped-source rerun branch |
| `https://www.youtube.com/@nanashi_77shi` | pending | not started in this skipped-source rerun branch |

## Runtime DB verification

The before/after DBs are YouTube-only builds with `--no-vsinger`.

| Metric | Before | After | Delta |
| --- | ---: | ---: | ---: |
| Videos | 3,284 | 3,732 | +448 |
| Songs | 19,982 | 21,298 | +1,316 |
| Occurrences | 62,562 | 69,305 | +6,743 |
| Source occurrences | 119,171 | 132,412 | +13,241 |

Per-channel DB probes after rebuild:

- `asuyumekanae` videos view: 189 videos, 3,674 occurrences; vtubers view: 1 row, 190 videos, 3,689 occurrences. The extra counts over accepted are pre-existing local data merged with this increment.
- `UtagawaLetora` videos view: 22 videos, 95 occurrences; sample handle normalized to `/@UtagawaLetora`.
- `Sen_44` videos view: 33 videos, 701 occurrences.

## HoshiHo time audit

The requested production example was audited before importing anything new and again after the local rebuild. It was already covered, so no inferred timestamps were added.

- Online API at `2026-07-20T00:07:52Z`: `HoshiHo` and `HoshiHo_HsH` both returned 2 videos and 65 occurrences; sampled videos had `publishedTimestamp` 2/2.
- Local before DB: videos 2; video `publishedTimestamp` 2/2; occurrence-table timed rows 89/89; video IDs `3EqUkBPOVrY`, `pmTcZgk8Q9g`.
- Local after DB: videos 2; video `publishedTimestamp` 2/2; occurrence-table timed rows 89/89; video IDs unchanged.

## Commands used for final verification

```powershell
npm run youtube:export-channel-increment -- --input-dir artifacts/channel-discovery/2026-07-20-source-backfill/Sen_44 --input-dir artifacts/channel-discovery/2026-07-20-source-backfill/HazukiHina --input-dir artifacts/channel-discovery/2026-07-20-source-backfill/YuNivirtualsinger --input-dir artifacts/channel-discovery/2026-07-20-source-backfill/SHALOYAMADA-Vsinger --input-dir artifacts/channel-discovery/2026-07-20-source-backfill/irorinaru --input-dir artifacts/channel-discovery/2026-07-20-source-backfill/suzuna_subaru --input-dir artifacts/channel-discovery/2026-07-20-source-backfill/UtagawaLetora --input-dir artifacts/channel-discovery/2026-07-20-source-backfill/SuzuhanaInori --input-dir artifacts/channel-discovery/2026-07-20-remote/vps5/Tamamachi_Pue --input-dir artifacts/channel-discovery/2026-07-20-remote/vps3/asuyumekanae --input-dir artifacts/channel-discovery/2026-07-20-remote/vps5/asuyumekanae-shard1 --input-dir artifacts/channel-discovery/2026-07-20-source-backfill/asuyumekanae-shard2 --input-dir artifacts/channel-discovery/2026-07-20-remote/vps3/asuyumekanae-shard3 --output data/external/youtube-channel-discovery/accepted/2026-07-20-source-backfill-wave1.json
npm run db:build -- --no-vsinger --youtube-channel-discovery-dir artifacts/channel-discovery/youtube-discovery-before --output artifacts/runtime/song-rank-youtube-before-wave1.sqlite
npm run db:build -- --no-vsinger --output artifacts/runtime/song-rank-youtube-after-wave1.sqlite
node --test test/youtube-channel-discovery.test.js
node --test test/import-channel-discovery.test.js
node --check scripts/youtube-channel-discovery-core.js
```

## VPS usage and cleanup

No culua or rainyun VPS was used. Credentials were only read locally and were not logged.

| Host | Role | Cleanup evidence |
| --- | --- | --- |
| VPS3 `142.91.109.81` | `asuyumekanae` shard 0 and shard 3 | removed `/opt/ytb-song-rank-source-backfill-20260720`; `df -h`: `/dev/sda1 99G 15G 84G 15% /`; `REMOTE_CLEANUP_OK` |
| VPS5 `134.195.91.5` | `Tamamachi_Pue` and `asuyumekanae` shard 1 | removed `/opt/ytb-song-rank-source-backfill-20260720`; `df -h`: `/dev/vda1 10G 2.4G 7.1G 26% /`; `REMOTE_CLEANUP_OK` |
| VPS2 / VPS4 | not used for work | authentication failed before creating project directories |

## Queued follow-up batch

The next batch is intentionally queued for later source-backfill commits. The integration session can deploy the first wave without waiting for this list.

- `https://www.youtube.com/@MikuroKotonoha/streams`
- `https://www.youtube.com/@nemgorochan`
- `https://www.youtube.com/@Chihiro_Ichiniwa`
- `https://www.youtube.com/@kohigashihitona`
- `https://www.youtube.com/@TsumugiCarla`
- `https://www.youtube.com/@Himawari_Hachiya`
- `https://www.youtube.com/@HONKTHEHORN_OFFICIAL`
- `https://www.youtube.com/@Mei-Mei2024`
- `https://www.youtube.com/@itk_tks` (already online in first-wave skip audit; keep as skip candidate unless new scope asks for a deeper refresh)
- `https://www.youtube.com/@KugaTamaki`
- `https://www.youtube.com/@UnoRabi`
- `https://www.youtube.com/@delutaya`
- `https://www.youtube.com/@akari0415`
- `https://www.youtube.com/@silk_mayui`
- `https://www.youtube.com/@ROMANY_io`
- `https://www.youtube.com/@nanashi_77shi`

## Completed second wave

Second wave was completed as an additional local commit on top of `90b9bcbe`. It still only covers the 16 requested URLs below; it is not a full-site channel refresh. Online skipped evidence was refreshed from `https://ytb-song-rank.culua.com/api/meta` and `/api/rankings` at `2026-07-20T02:06:53Z`. The production source at that time was `6afbad99b37b0ef2b11b679a7b4b315d98d37964`, built at `2026-07-19T23:49:16Z`.

- Accepted increment: `data/external/youtube-channel-discovery/accepted/2026-07-20-source-backfill-wave2.json`
- Increment totals: 7 discovery input dirs, 490 video details read, 490 accepted videos, 5,706 accepted occurrences, 0 duplicate video IDs, 0 regression skips.
- Time coverage in accepted increment: video `publishedTimestamp` 490/490; occurrence `time` or `seconds` 5,706/5,706.
- `origin/main` advanced again during this work to `fb0c33083be6f8cef88acbcc167c679f2148e40f`; this branch was intentionally not rebased, to avoid rewriting the first-wave commit already handed to the integration session.

| Source | Status | Evidence |
| --- | --- | --- |
| `https://www.youtube.com/@MikuroKotonoha/streams` | imported | candidates 214; inspected 214; accepted videos 111; accepted occurrences 1,160; unique songs 538; raw publishedAt 214/214; detail publishedTimestamp 111/111; occurrence time 1,160/1,160; reachedEnd true |
| `https://www.youtube.com/@nemgorochan` | skipped | already online: videos 2; occurrences 37; top video `sRPWlpO0jJw`; sample publishedTimestamp 2/2 |
| `https://www.youtube.com/@Chihiro_Ichiniwa` | imported | candidates 11; inspected 11; accepted videos 5; accepted occurrences 106; unique songs 101; raw publishedAt 11/11; detail publishedTimestamp 5/5; occurrence time 106/106; reachedEnd true |
| `https://www.youtube.com/@kohigashihitona` | skipped | already online: videos 2; occurrences 19; top video `vrFBDN3YWY0`; sample publishedTimestamp 2/2 |
| `https://www.youtube.com/@TsumugiCarla` | skipped | already online: videos 1; occurrences 9; top video `Sq2UU4dhsxU`; sample publishedTimestamp 1/1 |
| `https://www.youtube.com/@Himawari_Hachiya` | imported | candidates 273; inspected 273; accepted videos 147; accepted occurrences 2,284; unique songs 982; raw publishedAt 273/273; detail publishedTimestamp 147/147; occurrence time 2,284/2,284; reachedEnd true |
| `https://www.youtube.com/@HONKTHEHORN_OFFICIAL` | skipped | already online: videos 3; occurrences 44; top video `0WM72sIq1ss`; sample publishedTimestamp 2/2 |
| `https://www.youtube.com/@Mei-Mei2024` | skipped | already online: videos 1; occurrences 19; top video `fA4Xbt4gab4`; sample publishedTimestamp 1/1 |
| `https://www.youtube.com/@itk_tks` | skipped | already online: videos 4; occurrences 50; top video `L9Qgz6Z_dDg`; sample publishedTimestamp 2/2 |
| `https://www.youtube.com/@KugaTamaki` | imported | candidates 65; inspected 65; accepted videos 10; accepted occurrences 95; unique songs 93; raw publishedAt 65/65; detail publishedTimestamp 10/10; occurrence time 95/95; reachedEnd true |
| `https://www.youtube.com/@UnoRabi` | imported | candidates 42; inspected 42; accepted videos 15; accepted occurrences 142; unique songs 128; raw publishedAt 42/42; detail publishedTimestamp 15/15; occurrence time 142/142; reachedEnd true |
| `https://www.youtube.com/@delutaya` | skipped | already online: videos 4; occurrences 47; top video `_mlISsDUfag`; sample publishedTimestamp 2/2 |
| `https://www.youtube.com/@akari0415` | skipped | already online: videos 1; occurrences 10; top video `6tRCG16yNlw`; sample publishedTimestamp 1/1 |
| `https://www.youtube.com/@silk_mayui` | imported | candidates 174; inspected 174; accepted videos 119; accepted occurrences 1,033; unique songs 535; raw publishedAt 174/174; detail publishedTimestamp 119/119; occurrence time 1,033/1,033; reachedEnd true |
| `https://www.youtube.com/@ROMANY_io` | imported | candidates 171; inspected 171; accepted videos 83; accepted occurrences 886; unique songs 392; raw publishedAt 171/171; detail publishedTimestamp 83/83; occurrence time 886/886; reachedEnd true |
| `https://www.youtube.com/@nanashi_77shi` | skipped | already online: videos 2; occurrences 32; top video `ozRRqexN8lA`; sample publishedTimestamp 2/2 |

Second-wave YouTube-only DB before/after builds:

| Metric | Before wave2 | After wave2 | Delta |
| --- | ---: | ---: | ---: |
| Videos | 3,732 | 4,217 | +485 |
| Songs | 21,298 | 22,414 | +1,116 |
| Occurrences | 69,305 | 74,966 | +5,661 |
| Source occurrences | 132,412 | 143,520 | +11,108 |

Second-wave final commands:

```powershell
npm run youtube:export-channel-increment -- --input-dir artifacts/channel-discovery/2026-07-20-remote-wave2/vps3/MikuroKotonoha --input-dir artifacts/channel-discovery/2026-07-20-source-backfill-wave2/Chihiro_Ichiniwa --input-dir artifacts/channel-discovery/2026-07-20-remote-wave2/vps5/Himawari_Hachiya --input-dir artifacts/channel-discovery/2026-07-20-source-backfill-wave2/KugaTamaki --input-dir artifacts/channel-discovery/2026-07-20-source-backfill-wave2/UnoRabi --input-dir artifacts/channel-discovery/2026-07-20-source-backfill-wave2/silk_mayui --input-dir artifacts/channel-discovery/2026-07-20-source-backfill-wave2/ROMANY_io --output data/external/youtube-channel-discovery/accepted/2026-07-20-source-backfill-wave2.json
npm run db:build -- --no-vsinger --youtube-channel-discovery-dir artifacts/channel-discovery/youtube-discovery-before-wave2 --output artifacts/runtime/song-rank-youtube-before-wave2.sqlite
npm run db:build -- --no-vsinger --output artifacts/runtime/song-rank-youtube-after-wave2.sqlite
```

Second-wave VPS usage:

| Host | Role | Cleanup evidence |
| --- | --- | --- |
| VPS3 `142.91.109.81` | `MikuroKotonoha`; duplicate `silk_mayui` run was stopped after local completion | removed `/opt/ytb-song-rank-source-backfill-wave2-20260720`; final `df -h`: `/dev/sda1 99G 24G 76G 24% /`; `REMOTE_CLEANUP_OK` |
| VPS5 `134.195.91.5` | `Himawari_Hachiya`; duplicate `ROMANY_io` run was stopped after local completion | removed `/opt/ytb-song-rank-source-backfill-wave2-20260720`; final `df -h`: `/dev/vda1 10G 2.4G 7.1G 26% /`; `REMOTE_CLEANUP_OK` |

## Merge notes

- `origin/main` advanced to `f053651dfae375ab6f5595dfe322174abfa8d32d` after this branch was started. This branch keeps a small surface by adding separate accepted increment JSON files and a handoff doc instead of editing generated review data.
- Do not commit `artifacts/channel-discovery/**`, `artifacts/runtime/**`, remote raw caches, credentials, or temporary helper scripts.
- This branch has not been pushed and has not been deployed. The accepted JSON will affect production only after the integration session merges, rebuilds, and deploys.

## Completed low-count skipped-source gapfix

The integration check found that `https://www.youtube.com/@nanashi_77shi` had been skipped in wave 2 with only 2 online videos and 32 occurrences. That is not sufficient evidence for a complete source. I re-audited the same class of previously requested skipped sources whose online count was only 1-5 videos, without running a full-site 1000+ channel refresh.

Online evidence was refreshed from `https://ytb-song-rank.culua.com/api/meta` and `/api/rankings` at `2026-07-20T09:30:11Z`. Production source at that time was `62d895bfd1f06d2a0552006f53ad0ef9e0f9a865`, built at `2026-07-20T08:55:31Z`. Candidate-only probing then showed all 14 low-count skipped sources had complete channel pagination (`reachedEnd true`) and more candidate videos than the tiny online footprint, so all 14 were imported in this gapfix batch.

- Accepted increment: `data/external/youtube-channel-discovery/accepted/2026-07-20-source-backfill-gapfix.json`
- Increment totals: 18 discovery input dirs, 1,235 video details read, 1,204 usable videos, 1,202 accepted videos, 14,229 accepted occurrences, 31 duplicate video IDs deduped across shards, 2 existing-regression videos skipped (`bpL4I37EU_0`, `fA4Xbt4gab4`).
- Time coverage in accepted increment: video `publishedTimestamp` 1,202/1,202; occurrence `time` or `seconds` 14,229/14,229.
- Batch status: imported 14, skipped 0, failed 0, pending 0.

| Source | Status | Evidence |
| --- | --- | --- |
| `https://www.youtube.com/@karakurinne` | imported | candidates 25; inspected 25; accepted videos 23; accepted occurrences 228; unique songs 200; raw publishedAt 25/25; detail publishedTimestamp 23/23; occurrence time 228/228; reachedEnd true |
| `https://www.youtube.com/@Otokado_Ruki` | imported | candidates 227; inspected 227; accepted videos 173; accepted occurrences 1,911; unique songs 769; raw publishedAt 227/227; detail publishedTimestamp 173/173; occurrence time 1,911/1,911; reachedEnd true |
| `https://www.youtube.com/@itk_tks` | imported | sharded across local, VPS3, and VPS5. candidates 319; inspected 319; accepted videos 281; accepted occurrences 4,616; unique songs 699; raw publishedAt 319/319; detail publishedTimestamp 281/281; occurrence time 4,616/4,616; reachedEnd true |
| `https://www.youtube.com/@Stratia113` | imported | candidates 20; inspected 20; accepted videos 20; accepted occurrences 148; unique songs 144; raw publishedAt 20/20; detail publishedTimestamp 20/20; occurrence time 148/148; reachedEnd true |
| `https://www.youtube.com/@perucia_ten` | imported | candidates 8; inspected 8; accepted videos 7; accepted occurrences 82; unique songs 78; raw publishedAt 8/8; detail publishedTimestamp 7/7; occurrence time 82/82; reachedEnd true |
| `https://www.youtube.com/@HoshiHo_HsH` | imported | candidates 59; inspected 59; accepted videos 48; accepted occurrences 1,038; unique songs 865; raw publishedAt 59/59; detail publishedTimestamp 48/48; occurrence time 1,038/1,038; reachedEnd true |
| `https://www.youtube.com/@nemgorochan` | imported | sharded across local, VPS3, and VPS5. candidates 402; inspected 401; accepted videos 125; accepted occurrences 1,327; unique songs 667; raw publishedAt 402/402; detail publishedTimestamp 125/125; occurrence time 1,327/1,327; reachedEnd true |
| `https://www.youtube.com/@kohigashihitona` | imported | candidates 198; inspected 198; accepted videos 183; accepted occurrences 1,726; unique songs 851; raw publishedAt 198/198; detail publishedTimestamp 183/183; occurrence time 1,726/1,726; reachedEnd true |
| `https://www.youtube.com/@TsumugiCarla` | imported | candidates 193; inspected 193; accepted videos 135; accepted occurrences 1,116; unique songs 320; raw publishedAt 193/193; detail publishedTimestamp 135/135; occurrence time 1,116/1,116; reachedEnd true |
| `https://www.youtube.com/@HONKTHEHORN_OFFICIAL` | imported | candidates 22; inspected 22; accepted videos 17; accepted occurrences 164; unique songs 132; raw publishedAt 22/22; detail publishedTimestamp 17/17; occurrence time 164/164; reachedEnd true |
| `https://www.youtube.com/@Mei-Mei2024` | imported | candidates 90; inspected 90; accepted videos 30; accepted occurrences 130; unique songs 117; raw publishedAt 90/90; detail publishedTimestamp 30/30; occurrence time 130/130; reachedEnd true |
| `https://www.youtube.com/@delutaya` | imported | candidates 106; inspected 106; accepted videos 101; accepted occurrences 1,143; unique songs 615; raw publishedAt 106/106; detail publishedTimestamp 101/101; occurrence time 1,143/1,143; reachedEnd true |
| `https://www.youtube.com/@akari0415` | imported | candidates 74; inspected 74; accepted videos 23; accepted occurrences 120; unique songs 118; raw publishedAt 74/74; detail publishedTimestamp 23/23; occurrence time 120/120; reachedEnd true |
| `https://www.youtube.com/@nanashi_77shi` | imported | candidates 47; inspected 47; accepted videos 36; accepted occurrences 480; unique songs 382; raw publishedAt 47/47; detail publishedTimestamp 36/36; occurrence time 480/480; reachedEnd true. After-gapfix DB probe returned videos view 36 videos / 480 occurrences and vtubers view 1 row / 36 videos / 480 occurrences. |

Gapfix YouTube-only DB before/after builds:

| Metric | Before gapfix | After gapfix | Delta |
| --- | ---: | ---: | ---: |
| Videos | 4,217 | 5,382 | +1,165 |
| Songs | 22,414 | 25,312 | +2,898 |
| Occurrences | 74,966 | 88,750 | +13,784 |
| Source occurrences | 143,520 | 170,570 | +27,050 |

Gapfix commands:

```powershell
npm run youtube:export-channel-increment -- artifacts\channel-discovery\2026-07-20-source-backfill-gapfix\nemgorochan-shard2 artifacts\channel-discovery\2026-07-20-source-backfill-gapfix\itk_tks-shard2 artifacts\channel-discovery\2026-07-20-source-backfill-gapfix\nanashi_77shi artifacts\channel-discovery\2026-07-20-source-backfill-gapfix\akari0415 artifacts\channel-discovery\2026-07-20-source-backfill-gapfix\Mei-Mei2024 artifacts\channel-discovery\2026-07-20-source-backfill-gapfix\HoshiHo_HsH artifacts\channel-discovery\2026-07-20-source-backfill-gapfix\karakurinne artifacts\channel-discovery\2026-07-20-source-backfill-gapfix\HONKTHEHORN_OFFICIAL artifacts\channel-discovery\2026-07-20-source-backfill-gapfix\Stratia113 artifacts\channel-discovery\2026-07-20-source-backfill-gapfix\perucia_ten artifacts\channel-discovery\2026-07-20-remote-gapfix\vps3\nemgorochan-shard0 artifacts\channel-discovery\2026-07-20-remote-gapfix\vps3\itk_tks-shard0 artifacts\channel-discovery\2026-07-20-remote-gapfix\vps3\Otokado_Ruki artifacts\channel-discovery\2026-07-20-remote-gapfix\vps3\kohigashihitona artifacts\channel-discovery\2026-07-20-remote-gapfix\vps5\nemgorochan-shard1 artifacts\channel-discovery\2026-07-20-remote-gapfix\vps5\itk_tks-shard1 artifacts\channel-discovery\2026-07-20-remote-gapfix\vps5\TsumugiCarla artifacts\channel-discovery\2026-07-20-remote-gapfix\vps5\delutaya -- --output data\external\youtube-channel-discovery\accepted\2026-07-20-source-backfill-gapfix.json
npm run db:build -- --no-vsinger --youtube-channel-discovery-dir artifacts\channel-discovery\youtube-discovery-before-gapfix --output artifacts\runtime\song-rank-youtube-before-gapfix.sqlite
npm run db:build -- --no-vsinger --output artifacts\runtime\song-rank-youtube-after-gapfix.sqlite
npm run db:probe -- --db artifacts\runtime\song-rank-youtube-after-gapfix.sqlite --range all --view videos --q nanashi_77shi --page-size 5
npm run db:probe -- --db artifacts\runtime\song-rank-youtube-after-gapfix.sqlite --range all --view vtubers --q nanashi_77shi --page-size 5
```

Gapfix VPS usage:

| Host | Role | Cleanup evidence |
| --- | --- | --- |
| VPS3 `142.91.109.81` | `nemgorochan` shard 0, `itk_tks` shard 0, `Otokado_Ruki`, `kohigashihitona` | removed `/opt/ytb-song-rank-source-backfill-gapfix-20260720`; final `df -h`: `/dev/sda1 99G 15G 84G 16% /`; `REMOTE_CLEANUP_OK` |
| VPS5 `134.195.91.5` | `nemgorochan` shard 1, `itk_tks` shard 1, `TsumugiCarla`, `delutaya` | removed `/opt/ytb-song-rank-source-backfill-gapfix-20260720`; final `df -h`: `/dev/vda1 10G 2.5G 7.1G 26% /`; `REMOTE_CLEANUP_OK` |
