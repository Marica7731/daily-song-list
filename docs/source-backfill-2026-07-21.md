# Source backfill 2026-07-21

This run is a scoped YouTube source backfill. It does not refresh the full 1000+ channel estate. The batch covers only the 12 sources requested after the 2026-07-20 waves:

- `https://www.youtube.com/@NishizonoChigusa`
- `https://www.youtube.com/@NekoyashikiMiku`
- `https://www.youtube.com/@HaNaTaN_MUSiC`
- `https://www.youtube.com/@%E4%B8%80%E8%89%B2%E3%82%A4%E3%82%BA/streams`
- `https://www.youtube.com/@tenbin173/streams`
- `https://www.youtube.com/@Nijyuna714/streams`
- `https://www.youtube.com/@Nijyuuu7/streams`
- `https://www.youtube.com/@y_ha_ag_y`
- `https://www.youtube.com/@monicoch/streams`
- `https://www.youtube.com/@RirisyaMusic`
- `https://www.youtube.com/@KumahachiEma/streams`
- `https://www.youtube.com/@88nia88/streams`

## Branch and artifacts

- Clone: `D:\Projects\daily_song_list_worker_source_backfill_20260720`
- Branch: `codex/source-backfill-20260720-v2`
- Base before this batch: `9e8b8195 feat: 补跑低量跳过YouTube来源`
- Accepted increment: `data/external/youtube-channel-discovery/accepted/2026-07-21-source-backfill-new-sources.json`
- Export marker before review exclusions: `CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=16 readVideos=916 usableVideos=823 acceptedVideos=823 skippedRegressions=0 occurrences=9706`
- Manual review exclusions: 8 `NishizonoChigusa` false-positive videos, 98 occurrences. The excluded videos were game/APEX streams matched only because titles contained broad `歌` or `LIVE` text.
- Final accepted totals: 815 videos, 9,608 occurrences.
- Final time coverage: video `publishedTimestamp` 815/815; occurrence `time` 9,608/9,608; occurrence `seconds` 9,608/9,608.

## Online baseline reference

Production API was read at `2026-07-20T23:03:48Z` from `https://ytb-song-rank.culua.com/api/meta` and `/api/rankings?range=all&view=videos`. It was a read-only check, not a deployment.

- Production source commit: `d2ed5921aadffb39e6a2f3e6e70ac9b5a52c2d2e`
- Production build time: `2026-07-20T20:24:36Z`
- Production counts: videos 43,868; songs 63,888; occurrences 606,293; source occurrences 908,453.

| Query | Online videos | Online occurrences | Evidence |
| --- | ---: | ---: | --- |
| `NishizonoChigusa` | 0 | 0 | no online source rows |
| `NekoyashikiMiku` | 2 | 12 | low count only; not treated as complete source |
| `HaNaTaN_MUSiC` | 2 | 20 | low count only; not treated as complete source |
| `一色イズ` | 4 | 89 | low count only; not treated as complete source |
| `tenbin173` | 0 | 0 | no online source rows |
| `Nijyuna714` | 1 | 9 | low count only; not treated as complete source |
| `Nijyuuu7` | 0 | 0 | no online source rows |
| `y_ha_ag_y` | 3 | 26 | low count only; not treated as complete source |
| `monicoch` | 0 | 0 | no online source rows |
| `RirisyaMusic` | 0 | 0 | rescan requested; no online source rows for handle query |
| `KumahachiEma` | 1 | 38 | low count only; rescan requested |
| `88nia88` | 1 | 8 | low count only; moment-only data was not counted as collected |

## Source type audit

Moment-only data is not considered already collected for this workflow. Only self-crawled channel discovery increments or manually maintained source rows can justify `skipped`.

Low-video-count local audit result before this batch:

| Source type | Channels |
| --- | ---: |
| manual-or-snapshot-only | 746 |
| moment-only | 7 |
| self-crawled | 21 |
| total with fewer than 10 videos | 774 |

Requested-source audit before this batch:

| Source | Local/online evidence before import | Source type decision |
| --- | --- | --- |
| `NishizonoChigusa` | online 0 videos; local 0 videos | import |
| `NekoyashikiMiku` | online 2 videos / 12 occurrences; local manual-or-snapshot-only | import |
| `HaNaTaN_MUSiC` | online 2 videos / 20 occurrences; local manual-or-snapshot-only | import |
| `一色イズ` | online 4 videos / 89 occurrences; local manual-or-snapshot-only | import |
| `tenbin173` | online/local 0 videos | import |
| `Nijyuna714` | online 1 video / 9 occurrences | import |
| `Nijyuuu7` | online/local 0 videos | import |
| `y_ha_ag_y` | online 3 videos / 26 occurrences; local manual-or-snapshot-only | import |
| `monicoch` | online/local 0 videos | import |
| `RirisyaMusic` | rescan requested; no existing self-crawled accepted source found in local accepted increments | import |
| `KumahachiEma` | online/local 1 video / 38 occurrences | import |
| `88nia88` | moment catalog had 45 videos, but self-crawled accepted rows were absent/low-count | import |

## Channel results

All 12 requested sources reached a complete manifest and were imported. No source in this batch is marked `skipped`, `failed`, or `pending`.

| Source | Status | Discovery evidence | Accepted videos | Accepted occurrences | Unique songs | Time coverage |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `NishizonoChigusa` | imported | candidates 122; inspected 122; usable 68; 8 false positives reviewed out | 60 | 692 | 492 | published 60/60; time 692/692; seconds 692/692 |
| `NekoyashikiMiku` | imported | candidates 23; inspected 23; usable 19; reachedEnd true | 19 | 144 | 115 | published 19/19; time 144/144; seconds 144/144 |
| `HaNaTaN_MUSiC` | imported | candidates 98; inspected 98; usable 55; reachedEnd true | 55 | 339 | 288 | published 55/55; time 339/339; seconds 339/339 |
| `一色イズ` | imported | candidates 92; inspected 92; usable 85; reachedEnd true | 85 | 2,135 | 545 | published 85/85; time 2,135/2,135; seconds 2,135/2,135 |
| `tenbin173` | imported | candidates 201; inspected 201; usable 77; reachedEnd true | 77 | 418 | 344 | published 77/77; time 418/418; seconds 418/418 |
| `Nijyuna714` | imported | candidates 9; inspected 9; usable 8; reachedEnd true | 8 | 122 | 95 | published 8/8; time 122/122; seconds 122/122 |
| `Nijyuuu7` | imported | candidates 60; inspected 60; usable 25; reachedEnd true | 25 | 272 | 201 | published 25/25; time 272/272; seconds 272/272 |
| `y_ha_ag_y` | imported | candidates 51; inspected 51; usable 29; reachedEnd true | 29 | 190 | 149 | published 29/29; time 190/190; seconds 190/190 |
| `monicoch` | imported | candidates 67; inspected 67; usable 62; reachedEnd true | 62 | 784 | 322 | published 62/62; time 784/784; seconds 784/784 |
| `RirisyaMusic` | imported | 3 shards; candidate pages reachedEnd; 184 usable shard videos before dedupe | 158 | 1,973 | 1,198 | published 158/158; time 1,973/1,973; seconds 1,973/1,973 |
| `KumahachiEma` | imported | candidates 47; inspected 47; usable 33; reachedEnd true | 33 | 493 | 268 | published 33/33; time 493/493; seconds 493/493 |
| `88nia88` | imported | 3 shards; candidate pages reachedEnd; 271 usable shard videos before dedupe | 204 | 2,046 | 906 | published 204/204; time 2,046/2,046; seconds 2,046/2,046 |

## Runtime DB verification

The before/after DBs are local YouTube-only builds with `--no-vsinger`. They are used to verify this accepted increment cheaply and are not production deployment evidence.

| Metric | Before | After | Delta |
| --- | ---: | ---: | ---: |
| Videos | 5,382 | 6,174 | +792 |
| Songs | 25,312 | 27,336 | +2,024 |
| Occurrences | 88,750 | 98,058 | +9,308 |
| Source occurrences | 170,570 | 188,226 | +17,656 |
| Ranking rows | 113,224 | 119,605 | +6,381 |

Representative DB probes after rebuild:

- `NishizonoChigusa`: videos view 58 videos, 682 occurrences. Top row after review is `9bjQ8fM4xn0` Birthday Live; the reviewed-out game/APEX rows are no longer in the local after DB.
- `88nia88`: videos view 204 videos, 2,046 occurrences.
- `KumahachiEma`: videos view 33 videos, 493 occurrences.
- `RirisyaMusic`: videos view 158 videos, 1,973 occurrences.

## Long-run handling and VPS cleanup

Long source crawling was split between local execution and a remote worker subtask. Local and remote commands used resumable channel discovery output directories and manifest checks. Interrupted/timeout state was not counted as success; only directories with complete `manifest.json`, `video-details.json`, and final status were exported.

Non-culua, non-雨云 VPS workers used isolated temporary roots only:

- VPS3: `/opt/ytb-song-rank-source-backfill-20260721-4ch`
- VPS5: `/opt/ytb-song-rank-source-backfill-20260721-4ch`

After pulling results back, the worker removed those roots. Cleanup verification:

| Host | Cleanup | `df -h /` summary |
| --- | --- | --- |
| VPS3 | remote root missing after cleanup | `/dev/sda1 99G 24G 75G 25% /` |
| VPS5 | remote root missing after cleanup | `/dev/vda1 10G 2.5G 7.1G 26% /` |

## Commands used for verification

```powershell
npm run youtube:export-channel-increment -- --input-dir artifacts\channel-discovery\2026-07-21-source-backfill-full\88nia88-shard2 --input-dir artifacts\channel-discovery\2026-07-21-source-backfill-full\RirisyaMusic-shard2 --input-dir artifacts\channel-discovery\2026-07-21-source-backfill-full\Isshiki_Izu --input-dir artifacts\channel-discovery\2026-07-21-source-backfill-full\monicoch --input-dir artifacts\channel-discovery\2026-07-21-source-backfill-full\Nijyuuu7 --input-dir artifacts\channel-discovery\2026-07-21-source-backfill-full\y_ha_ag_y --input-dir artifacts\channel-discovery\2026-07-21-source-backfill-full\KumahachiEma --input-dir artifacts\channel-discovery\2026-07-21-source-backfill-full\Nijyuna714 --input-dir artifacts\channel-discovery\2026-07-21-source-backfill-remote-download\vps3\88nia88-shard0 --input-dir artifacts\channel-discovery\2026-07-21-source-backfill-remote-download\vps3\RirisyaMusic-shard0 --input-dir artifacts\channel-discovery\2026-07-21-source-backfill-remote-download\vps3\tenbin173 --input-dir artifacts\channel-discovery\2026-07-21-source-backfill-remote-download\vps3\NekoyashikiMiku --input-dir artifacts\channel-discovery\2026-07-21-source-backfill-remote-download\vps5\88nia88-shard1 --input-dir artifacts\channel-discovery\2026-07-21-source-backfill-remote-download\vps5\RirisyaMusic-shard1 --input-dir artifacts\channel-discovery\2026-07-21-source-backfill-remote-download\vps5\NishizonoChigusa --input-dir artifacts\channel-discovery\2026-07-21-source-backfill-remote-download\vps5\HaNaTaN_MUSiC --output data\external\youtube-channel-discovery\accepted\2026-07-21-source-backfill-new-sources.json
npm run db:build -- --no-vsinger --youtube-channel-discovery-dir artifacts\channel-discovery\youtube-discovery-before-20260721 --output artifacts\runtime\song-rank-youtube-before-20260721.sqlite
npm run db:build -- --no-vsinger --output artifacts\runtime\song-rank-youtube-after-20260721.sqlite
npm run db:probe -- --db artifacts\runtime\song-rank-youtube-after-20260721.sqlite --range all --view videos --q NishizonoChigusa --page-size 1
npm run db:probe -- --db artifacts\runtime\song-rank-youtube-after-20260721.sqlite --range all --view videos --q 88nia88 --page-size 1
npm run db:probe -- --db artifacts\runtime\song-rank-youtube-after-20260721.sqlite --range all --view videos --q KumahachiEma --page-size 1
npm run db:probe -- --db artifacts\runtime\song-rank-youtube-after-20260721.sqlite --range all --view videos --q RirisyaMusic --page-size 1
```

No push, deployment, service restart, or production DB rebuild was done in this branch.
