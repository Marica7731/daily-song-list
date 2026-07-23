# Batch96 HimesakiYumeno Duplicate Evidence

Status: `skipped_duplicate`

Reason: `duplicate_concrete_accepted_artifact_exists`

Duplicate of batch: `2026-07-22-source-backfill-batch3`

## Scope

This is a duplicate-evidence artifact only. It did not rerun YouTube discovery, did not use Mac or VPS execution, did not create a remote temporary directory, did not write `data/external`, did not rebuild any production DB, and did not push, deploy, or publish anything.

The accepted increment is intentionally empty because `HimesakiYumeno` is already fully recorded in the batch3 concrete accepted artifact. This batch does not repeat accepted rows.

## Evidence Sources

- `artifacts/channel-discovery/2026-07-22-source-backfill-batch3/accepted/2026-07-22-source-backfill-batch3.accepted.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch3/manifest.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch3/report.md`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch3/dirty-audit.json`

## Batch3 HimesakiYumeno Accepted Evidence

| Channel | Status | Videos | Occurrences | Unique songs | Coverage | Cover coverage |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `HimesakiYumeno` | skipped duplicate; already imported in batch3 | 52 | 698 | 471 | published 52/52; time 698/698; seconds 698/698 | discovery thumbnail 52/52; cover 52/52 |

## Batch3 Source Manifest Entry

| Field | Value |
| --- | ---: |
| discoveryCandidateCount | 81 |
| discoveryInspectedCount | 81 |
| discoveryUsableVideoCount | 52 |
| discoveryOccurrenceCount | 698 |
| elapsedSeconds | 1932 |
| reachedEnd | null |

`reachedEnd` is intentionally recorded as `null`, matching the batch3 source manifest.

## Dirty Audit

The dirty audit in this artifact is filtered only to `HimesakiYumeno`.

- Batch3 dirty audit dropped: 0 videos / 0 occurrences.
- Batch3 suspiciousCount: 11.
- HimesakiYumeno channel-level suspiciousCount: 10.
- The 10 HimesakiYumeno suspicious rows are broad live hits retained after manual audit.
- ChitaCh has the other 1 suspicious row from batch3 and is not part of this batch96 channel filter.
- Suspicious rows are not dirty dropped.
- The difference between 81 candidates and 52 usable videos is not dirty dropped.

## Remote Cleanup Evidence Referenced From Batch3

Batch96 did not use Mac, VPS, or any remote temporary directory. Batch3 report/manifest include these remote cleanup `df -h /` lines:

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch3-vps3`: removed; `df -h /` => `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch3-vps5`: removed; `df -h /` => `/dev/vda1 10G 2.6G 7.0G 27% /`.

## Outputs

Generated exactly these 5 small files in `artifacts/channel-discovery/2026-07-23-source-backfill-batch96-himesakiyumeno-duplicate-evidence/`:

- `candidate-increment-unfiltered.json`
- `accepted-increment.json`
- `dirty-audit.json`
- `manifest.json`
- `report.md`
