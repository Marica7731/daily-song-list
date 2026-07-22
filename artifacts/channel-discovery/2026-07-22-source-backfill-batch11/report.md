# 2026-07-22-source-backfill-batch11

Scope: eleventh small batch for the 2026-07-22 requested source queue; not a full 1000+ channel rescan.

## Source status

| Source | URL | Status | Discovery | Accepted videos/occurrences/songs | Time coverage | Thumbnail coverage | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| UCw0ty0mpHBx6xZt-K_hfNcA | https://www.youtube.com/channel/UCw0ty0mpHBx6xZt-K_hfNcA | imported | 121/121 inspected; usable 38; occurrences 496 | 38/496/291 | published 38/38; time 496/496; seconds 496/496 | 38/38 | complete remote manifest accepted into batch11 artifact increment |
| SoraOtoha | https://www.youtube.com/@SoraOtoha | failed | 64/127 inspected; usable 0; occurrences 0 | 0/0/0 | published 0/0; time 0/0; seconds 0/0 | 0/0 | remote discovery hit timeout before producing a complete manifest; checkpoint summary preserved for later retry |

## Dirty audit

- Dropped videos/occurrences: 0/0.
- Suspicious videos: 1 (broad live/live terms only, not dropped blindly).

## DB verification

- Before: videos 6595; songs 28903; occurrences 104213; sourceOccurrences 200068; rankingRows 124291.
- After: videos 6632; songs 28990; occurrences 104708; sourceOccurrences 201051; rankingRows 124628.
- Delta: videos 37; songs 87; occurrences 495; sourceOccurrences 983; rankingRows 337.
- Channel probe UCw0ty0mpHBx6xZt-K_hfNcA: 1/14 -> 38/509.

## Remote cleanup

- vps3: removed; /dev/sda1 99G 11G 89G 11% /; marker=CODEX_REMOTE_BATCH11_CLEANUP_OK.
- vps5: removed; /dev/vda1 10G 2.6G 7.0G 27% /; marker=CODEX_REMOTE_BATCH11_CLEANUP_OK.

## Notes

- Local first attempt failed fast with YouTube fetch failed; remote retry completed UCw0ty0mpHBx6xZt-K_hfNcA.
- SoraOtoha timed out at 2400s with checkpoint 64/127 and no complete manifest, so it is not counted as imported.
