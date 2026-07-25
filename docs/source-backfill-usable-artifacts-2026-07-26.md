# Source-backfill usable artifact delivery (2026-07-26)

## Baseline and scope

- Branch base: `c0984812fb0645adba675f07be08ad78ca53885c`.
- Current main accepted files inspected: 31.
- No Windows crawler, Mac job, database import, merge, or deployment was started.
- Only reached-end or consolidated concrete accepted artifacts were considered.

## Accepted delivery

| Source | Source videos/occurrences | Main overlap | Production overlap | Selected | Cleaned |
| --- | ---: | ---: | ---: | ---: | ---: |
| KOTATSU | 40 / 420 | 0 | 1 | 39 / 417 | 34 / 394 |
| Arale | 117 / 991 | 0 | 3 | 114 / 963 | 113 / 950 |
| UCw0ty | 38 / 496 | 0 | 0 | 38 / 496 | 34 / 490 |

- KOTATSU production currently exposes 3 exact-channel videos; one source video was removed by videoId.
- Arale production currently exposes 6 exact-channel videos; three source videos were removed by videoId.
- UCw0ty production currently exposes one exact-channel video, which does not overlap the 38-video artifact.
- Final outputs contain 181 videos / 1834 occurrences with zero main or production overlap.
- Every final video has usable songs and publishedTimestamp coverage.
- Every occurrence has both time and numeric seconds.
- No duplicate videoId exists within or across the three outputs.

## Conservative parser repairs

- KOTATSU raw `1,0/amazarashi` was parsed as title `0`; another occurrence in the same artifact records the same song as `1.0 / amazarashi`. The selected row was repaired to title `1.0`.
- Arale raw `HAPPYぱLUCKY / SoLaMi♡SMILE` had artist `未記載`; the next performance in the same video records `SoLaMi♡SMILE (TAKE2)`. The selected row was repaired to artist `SoLaMi♡SMILE`.
- The current cleaner accepted both repaired rows.
- The first cleaner pass was not treated as proof of semantic cleanliness. A separate bounded scan reviewed `title`, `artist`, and `raw` for all 1876 selected occurrences.
- Content curation removed 42 high-confidence non-song chapters and 10 videos left with no usable songs.
- Cleaner write after content curation retained 181 videos / 1834 occurrences with zero additional drops.
- The second cleaner dry-run was stable for all three files: `changedFiles=0`, `droppedVideos=0`, `droppedSongs=0`.

## Content-level audit

| Source | Before | After | Dropped videos | Dropped occurrences |
| --- | ---: | ---: | ---: | ---: |
| KOTATSU | 39 / 417 | 34 / 394 | 5 | 23 |
| Arale | 114 / 963 | 113 / 950 | 1 | 13 |
| UCw0ty | 38 / 496 | 34 / 490 | 4 | 6 |

KOTATSU drop reasons:

| Reason | Count |
| --- | ---: |
| Artist-only marker | 1 |
| Equipment/tuning | 1 |
| Event announcement | 1 |
| Feature explanation | 1 |
| Generic setlist marker | 1 |
| Greeting/chat | 3 |
| Pause marker | 1 |
| Reaction comment | 4 |
| Sound effect | 1 |
| Spoken comment | 4 |
| Story chapter | 2 |
| Stream break | 1 |
| Thanks/chat | 1 |
| Viewer bookmark | 1 |

Arale drop reasons:

| Reason | Count |
| --- | ---: |
| Channel in-joke | 3 |
| Event segment | 1 |
| Food/drink comment | 1 |
| Guest arrival | 1 |
| Impersonation | 1 |
| Naming moment | 1 |
| Spoken comment | 2 |
| Unidentified encore marker | 1 |
| Viewer bookmark | 1 |
| Viewer UI comment | 1 |

UCw0ty drop reasons:

| Reason | Count |
| --- | ---: |
| Impersonation | 1 |
| Spoken mistake | 1 |
| Subscriber milestone | 2 |
| Viewer bookmark | 2 |

Deleted high-confidence examples include `羽緒たんのモノマネ(似てない)`,
`人外モノマネ`, `5000人`, `一万人達成`, `個人的に縦はすごく見づらい`,
`10月5日 Vlastfest03`, and `(自分用)`.

Potential song titles were retained when the evidence was ambiguous. Examples include
`Merry Christmas / 未記載`, `牛タン / 未記載`, `安眠のお供に / 未記載`,
`プライド…プリキュア♪ / 未記載`, and `ハッピーシンセサイザ / 未記載`
whose raw text identifies Easy Pop. Unknown artist and singleton status were never
used as deletion criteria.

The known songs `1.0 / amazarashiさん` and
`HAPPYぱLUCKY / SoLaMi♡SMILE` are still present with their original evidence
hashes. Strict validation passed with `publishedTimestamp=181/181`,
`time=1834/1834`, and `seconds=1834/1834`.

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
