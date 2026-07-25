# Selective source-backfill delivery (2026-07-26)

This delivery starts from GitHub `main` and does not import the mixed worker
batch wholesale. Every accepted video is selected by exact `channelId`, then
removed when its `videoId` already exists in the current production API.

## Production baseline

- GitHub `main`: `1d2bf94f6e69fbefc5a9e488d8fd77de1569f414`
- Production source commit: `1d2bf94f6e69fbefc5a9e488d8fd77de1569f414`
- Production built at: `2026-07-25T19:49:07Z`
- API: `https://ytb-song-rank.culua.com/api/rankings?range=all&view=videos`

## Batch A1

Accepted file:

- `data/external/youtube-channel-discovery/accepted/2026-07-26-source-backfill-selective-a1.json`

Production dedup before accepted cleanup:

| Source | Source videos | Already in production | Selected |
| --- | ---: | ---: | ---: |
| MonicaMelodia | 3 | 2 | 1 |
| ShirazunaIwo | 48 | 45 | 3 |
| toamall | 7 | 5 | 2 |
| UzakiLarme | 16 | 15 | 1 |
| SoraOtoha | 13 | 0 | 13 |
| Total | 87 | 67 | 20 |

The Sora rows were selected from
`2026-07-25-source-backfill-batch202-6channels.json` by exact channel ID
`UC9XsF9M7lZ1BSABHjKatOSA`. Rows for Nijyuna, Kumahachi Ema,
Nekoyashiki Miku, monicoch, and HaNaTaN were not copied.

Current accepted cleaner:

- Initial dry-run: `20 -> 19 videos`, `246 -> 241 occurrences`
- Write result: dropped 1 video and 5 non-song/duplicate rows
- Stable dry-run after write: `19 -> 19 videos`, `241 -> 241 occurrences`,
  `changedFiles=0`
- The dropped video was `MJ21y6OkMqk`; its only parsed row was an
  emoticon/chat fragment rather than a song title.
- Two Sora rows were explicit dance/merchandise chat markers; two additional
  rows were same-second translated aliases.

Final A1 coverage:

- Videos: 19
- Occurrences: 241
- `publishedTimestamp`: 19/19
- `time`: 241/241
- `seconds`: 241/241
- Final production overlap: 0/19 by construction; cleanup only removed rows.

Final source distribution:

| Source | Videos | Occurrences |
| --- | ---: | ---: |
| MonicaMelodia | 1 | 9 |
| ShirazunaIwo | 3 | 32 |
| toamall | 1 | 7 |
| UzakiLarme | 1 | 7 |
| SoraOtoha | 13 | 186 |

## Constraints retained

- No crawler was started.
- No `--fresh` run was used.
- No frontend file was touched.
- No database import, merge, or deployment was performed.

## Batch A2: Ebakyouka production-deduplicated increment

- Source accepted: 278 videos.
- Exact production channel query: 217 videos; 170 source videoIds already present.
- Pre-clean selective output: 108 videos / 1498 occurrences; production videoId overlap: 0.
- Normalization: every selected video uses channelId `UChpkyQ3O21OnkcMcgCoNHCg`, handle `/@ebakyouka`, and canonical channel URL.
- Cleaner write: 108 -> 103 videos; 1498 -> 1476 occurrences. The 22 removed rows were request instructions, likely non-song chat/start markers, or a bad artist field; five videos became empty and were removed.
- Stable cleaner dry-run: 103 -> 103 videos; 1476 -> 1476 occurrences; changedFiles=0.
- Final coverage: publishedTimestamp 103/103; occurrence.time 1476/1476; occurrence.seconds 1476/1476.
- Final production videoId overlap remains 0/103 because cleaning only removed rows from the pre-clean zero-overlap set.
- Accepted file: `data/external/youtube-channel-discovery/accepted/2026-07-26-source-backfill-ebakyouka-dedup.json`.
