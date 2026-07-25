# Source-backfill usable artifact delivery (2026-07-26)

## Baseline and scope

- Branch base: `c0984812fb0645adba675f07be08ad78ca53885c`.
- Current main accepted files inspected: 31.
- No Windows crawler, Mac job, database import, merge, or deployment was started.
- Only reached-end or consolidated concrete accepted artifacts were considered.

## Accepted delivery

| Source | Source videos/occurrences | Main overlap | Production overlap | Selected | Cleaned |
| --- | ---: | ---: | ---: | ---: | ---: |
| KOTATSU | 40 / 420 | 0 | 1 | 39 / 417 | 39 / 417 |
| Arale | 117 / 991 | 0 | 3 | 114 / 963 | 114 / 963 |
| UCw0ty | 38 / 496 | 0 | 0 | 38 / 496 | 38 / 496 |

- KOTATSU production currently exposes 3 exact-channel videos; one source video was removed by videoId.
- Arale production currently exposes 6 exact-channel videos; three source videos were removed by videoId.
- UCw0ty production currently exposes one exact-channel video, which does not overlap the 38-video artifact.
- Final outputs contain 191 videos / 1876 occurrences with zero main or production overlap.
- Every final video has usable songs and publishedTimestamp coverage.
- Every occurrence has both time and numeric seconds.
- No duplicate videoId exists within or across the three outputs.

## Conservative parser repairs

- KOTATSU raw `1,0/amazarashi` was parsed as title `0`; another occurrence in the same artifact records the same song as `1.0 / amazarashi`. The selected row was repaired to title `1.0`.
- Arale raw `HAPPYぱLUCKY / SoLaMi♡SMILE` had artist `未記載`; the next performance in the same video records `SoLaMi♡SMILE (TAKE2)`. The selected row was repaired to artist `SoLaMi♡SMILE`.
- The current cleaner accepted both repaired rows.
- Cleaner write: 191 -> 191 videos and 1876 -> 1876 occurrences.
- Stable cleaner dry-run: changedFiles=0, droppedVideos=0, droppedSongs=0.

## Accepted files

- `data/external/youtube-channel-discovery/accepted/2026-07-26-source-backfill-kotatsu-main-production-dedup.json`
- `data/external/youtube-channel-discovery/accepted/2026-07-26-source-backfill-arale-yumemita-main-production-dedup.json`
- `data/external/youtube-channel-discovery/accepted/2026-07-26-source-backfill-ucw0ty0mp-main-production-dedup.json`

## Felicia Lulufleur identity and hydration

- Official URL: `https://www.youtube.com/@FeliciaLulufleur`.
- The official page returned channelId `UClHap4tvcYZnyiqgAyEs0BQ` with HTTP 200.
- c0984812 main accepted and `data/latest.json` contain zero Felicia videos.
- Production display-name search contains 239 videos / 3293 occurrences.
- Before hydration, all 239 production records lack channelId, channelHandle, and channelUrl; handle and channelId queries return zero while display-name search returns 239.
- Added one official metadata cache entry with display name `ふぇりしあ / Felicia Ch`, handle `/@FeliciaLulufleur`, canonical URL, channelId, and official avatar.
- Existing hydration code fills channelId/handle/url for 239/239 records. Local handle and display-name query simulation both match 239/239 after hydration.

## Felicia bounded probe and checkpoint

- No existing Felicia discovery artifact or accepted increment was found.
- The official `/streams` and `/videos` first pages exposed 55 unique videoIds.
- Production already contains 11; 44 are production-missing first-page candidates.
- The page probe contains no usable song/time detail, so accepted output is 0 videos / 0 occurrences and cleaner is not applicable.
- The 44 candidate IDs and evidence are stored in `artifacts/channel-discovery/2026-07-26-source-backfill-felicia-lightweight-probe/manifest.json`.
- Any continuation must wait for the current main release, then use a bounded Mac checkpoint without `--fresh`; the Windows task must not run a long crawl.

## Deferred sources

- Amanofu Stella, Kyoka, and Uten Hiyori remain deferred until the current main release settles.
