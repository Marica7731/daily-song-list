# 2026-07-22-source-backfill-batch12

Scope: twelfth small batch for the 2026-07-22 requested source queue; not a full 1000+ channel rescan.

## Source status

| Source | URL | Status | Discovery | Accepted videos/occurrences/songs | Time coverage | Thumbnail coverage | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| omaru_piano | https://www.youtube.com/@omaru_piano/streams | failed | 139/143 inspected; usable 0; occurrences 0 | 0/0/0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | remote discovery hit timeout before producing a complete manifest; checkpoint summary preserved for later retry |
| saclayui | https://www.youtube.com/@saclayui/streams | imported | 179/179 inspected; usable 20; occurrences 124 | 1/2/2 | published 1/1; time 2/2; seconds 2/2 | 1/1 | complete remote manifest accepted after instrumental/non-song-frame dirty audit |

## Dirty audit

- Dropped videos/occurrences: 19/122.
- Drop rules included flute, live performance, clarinet, saxophone terms, exact `piano streaming`, exact `ピアノ演奏`, plus manual non-song-frame drops.
- Suspicious videos: 1 (broad live/live terms only, not dropped blindly).

## DB verification

- Before: videos 6632; songs 28990; occurrences 104708; sourceOccurrences 201051; rankingRows 124628.
- After: videos 6633; songs 28990; occurrences 104710; sourceOccurrences 201053; rankingRows 124631.
- Delta: videos 1; songs 0; occurrences 2; sourceOccurrences 2; rankingRows 3.
- Channel probe saclalive: 0/0 -> 1/2.

## Remote cleanup

- vps3: removed; /dev/sda1 99G 11G 88G 11% /; marker=CODEX_REMOTE_BATCH12_CLEANUP_OK.
- vps5: removed; /dev/vda1 10G 2.6G 7.0G 28% /; marker=CODEX_REMOTE_BATCH12_CLEANUP_OK.

## Notes

- omaru_piano timed out at 2700s with checkpoint 139/143 and no usable videos, so it is not counted as imported.
- saclayui raw export found 20 videos/124 occurrences; dirty audit kept only the clear `#歌枠` video and dropped instrumental/non-song-frame content.
