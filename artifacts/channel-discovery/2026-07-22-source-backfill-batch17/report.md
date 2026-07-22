# 2026-07-22 source backfill batch17

This batch retried `omaru_piano` on one host with lower concurrency. It does not contain an accepted increment and does not modify `data/external`.

## Status

| Source | Status | Candidates | Inspected | Checkpoint usable videos | Occurrences | Accepted videos | Reason |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `https://www.youtube.com/@omaru_piano/streams` | failed | 148 | 96 | 24 | 0 | 0 | 3600s timeout before complete manifest |

## Evidence

- Remote source commit: `9b4ee48c6d1b75eb0272aa1a7f8d8ac1d8f58252`.
- Runner settings: single `vps5` process, `request-interval-ms=7000`, `request-jitter-ms=2000`, `max-candidates=160`, `max-inspect=160`.
- Previous batch12 attempt reached `139/143` inspected with 0 occurrences but no complete manifest.
- This batch17 attempt reached `96/148` inspected with 0 occurrences and no complete manifest.
- No accepted increment was generated because partial checkpoint details are not a valid source import.

## Dirty Audit

Strict instrument filtering still applies before any future import:

- Drop indicators: `フルート`, `生演奏`, `クラリネット`, `サックス`, `サクソフォン`, `sax`, `saxophone`.
- Exact phrase drops: `piano streaming`, `ピアノ演奏`.
- Suspicious-only indicators: `live`, `ライブ`.

The audit is not finalized in this batch because discovery did not complete.

## Remote Cleanup

- `vps5`: removed `/opt/ytb-song-rank-source-backfill-20260722-batch17-vps5`; `df -h` after cleanup: `/dev/vda1 10G 2.6G 6.9G 28% /`.
