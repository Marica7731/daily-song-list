# 2026-07-22 YouTube source backfill batches 1-10

This note records the phased source release reviewed at
`2026-07-22T09:35:07+08:00`.

The source worker branch contains artifact commits only for batch1-batch10, but
the branch itself is not a merge target: it is divergent from current `main` and
also contains raw exports, remote status, manifests, reports, checkpoints, and
worker logs. The release input for this phase is the minimal accepted set copied
into `data/external/youtube-channel-discovery/accepted/`.

## Release inputs

Only these files are release inputs:

- `data/external/youtube-channel-discovery/accepted/2026-07-22-source-backfill-batch1.accepted.json`
- `data/external/youtube-channel-discovery/accepted/2026-07-22-source-backfill-batch2.accepted.json`
- `data/external/youtube-channel-discovery/accepted/2026-07-22-source-backfill-batch3.accepted.json`
- `data/external/youtube-channel-discovery/accepted/2026-07-22-source-backfill-batch4.accepted.json`
- `data/external/youtube-channel-discovery/accepted/2026-07-22-source-backfill-batch5.accepted.json`
- `data/external/youtube-channel-discovery/accepted/2026-07-22-source-backfill-batch6.accepted.json`
- `data/external/youtube-channel-discovery/accepted/2026-07-22-source-backfill-batch7.accepted.json`
- `data/external/youtube-channel-discovery/accepted/2026-07-22-source-backfill-batch8.accepted.json`
- `data/external/youtube-channel-discovery/accepted/2026-07-22-source-backfill-batch9.accepted.json`
- `data/external/youtube-channel-discovery/accepted/2026-07-22-source-backfill-batch10.accepted.json`

Do not copy or commit `*.raw-export.json`, `remote-status/`, `status.jsonl`,
`summary.json`, `manifest.json`, `dirty-audit.json`, or `remote-download/` from
the worker artifacts. Those remain evidence for the source worker only.

Batch11 is intentionally excluded from this phase. At review time its worker
directory only had `local-run/` and `local-status/`; there was no accepted
increment to release.

## Batch summary

| Batch | Channels | Release videos | Release occurrences | Dirty audit notes |
| --- | --- | ---: | ---: | --- |
| batch1 | `MonicaMelodia`, `ShirazunaIwo` | 49 | 692 | Dropped 1 non-song/member-only concert talk row before export; release cleanup dropped 116 source rows. |
| batch2 | `toamall`, `UzakiLarme`, `AmakusaAroma` | 33 | 355 | Dropped 2 unrelated `Santo Rosario / Live Ao vivo` rows before export; release cleanup dropped 1 video / 1 row. |
| batch3 | `HimesakiYumeno`, `ChitaCh` | 68 | 879 | No drops; broad live hits were reviewed, not blindly dropped. |
| batch4 | `Kamisatoniina`, `sakisakatsumugi` | 41 | 550 | No drops. |
| batch5 | `rayray_429`, `irorinaru` | 12 | 169 | Release cleanup dropped 1 video / 1 row. |
| batch6 | `RukaCh`, `inori_hw8` | 55 | 584 | No drops; broad live hits were reviewed, not blindly dropped. |
| batch7 | `Chiyutori` | 27 | 909 | No drops; pending `KOTATSU` checkpoint not included. |
| batch8 | `NUROJUNK_OFFICIAL`, `Dia`, `KOKONEch_uv` | 34 | 472 | No drops; pending channels not included. |
| batch9 | `kisaki`, `KAMIKUMONONOA` | 30 | 370 | No drops; broad live hits were reviewed, not blindly dropped. |
| batch10 | `hanaoto_youtube33`, `UCnKt20HH_BiuID0FDHGMcvw` | 102 | 1361 | Dropped 54 flute/instrumental videos and 840 occurrences. |

Total release payload for this phase: 451 videos and 6341 occurrences. The
worker export before release cleanup was 453 videos and 6459 occurrences.

## Cleaning notes

The batch10 flute review is the reusable rule from this pass. Exact
instrumental/source-format rows such as `flute`, `#flute`, `フルート`, and
instrument-only stream markers are high-confidence drops when they appear as
unknown-artist source rows. Do not broaden this into a generic `live` or
`ライブ` drop; batch3, batch6, and batch9 had broad live hits that were retained
after review.

The five retained batch10 videos that looked broad at first review were checked
as actual song streams or 3D live setlists and remain included:

- `s2lJX-b0buQ`
- `DzzUX7eTQhI`
- `kIL50HCHLZI`
- `jc37BBQ6fgI`
- `wRuvaDjDEs0`

## Validation

Before publishing a future batch, run the accepted cleanup and runtime checks
from the main repo after copying only `*.accepted.json`:

```powershell
npm run youtube:clean-channel-discovery -- --dry-run
npm run test:db
npm run db:build -- --no-vsinger --output artifacts/runtime/song-rank-youtube-source-batch.sqlite
```

Then probe representative channels through the local SQLite and, after deploy,
through `https://ytb-song-rank.culua.com/api/rankings`.
