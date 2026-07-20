# Source backfill 2026-07-20

This run is a scoped YouTube source backfill, not a full refresh of every channel on the site. The completed wave covers the 14 originally requested sources plus the user-added `Tamamachi_Pue` and `asuyumekanae`, 16 sources total. A later 16-source batch is recorded at the end of this document as queued follow-up work.

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

## Merge notes

- `origin/main` advanced to `6afbad99b37b0ef2b11b679a7b4b315d98d37964` after this branch was started. This branch keeps a small surface by adding a separate handoff doc and one accepted increment JSON instead of editing generated review data.
- Do not commit `artifacts/channel-discovery/**`, `artifacts/runtime/**`, remote raw caches, credentials, or temporary helper scripts.
- This branch has not been pushed and has not been deployed. The accepted JSON will affect production only after the integration session merges, rebuilds, and deploys.
