# Batch97 sakisakatsumugi Duplicate Evidence

Status: `skipped_duplicate`

Reason: `duplicate_concrete_accepted_artifact_exists`

Duplicate of batch: `2026-07-22-source-backfill-batch4`

## Scope

This is a duplicate-evidence artifact only. It did not rerun YouTube discovery, did not use Mac or VPS execution, did not create a remote temporary directory, did not write `data/external`, did not rebuild any production DB, and did not push, deploy, or publish anything.

The accepted increment is intentionally empty because `sakisakatsumugi` is already fully recorded in the batch4 concrete accepted artifact. This batch does not repeat accepted rows.

## Evidence Sources

- `artifacts/channel-discovery/2026-07-22-source-backfill-batch4/accepted/2026-07-22-source-backfill-batch4.accepted.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch4/manifest.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch4/report.md`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch4/dirty-audit.json`

## Batch4 sakisakatsumugi Accepted Evidence

| Channel | Status | Videos | Occurrences | Unique songs | Coverage | Cover coverage |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `sakisakatsumugi` | skipped duplicate; already imported in batch4 | 19 | 223 | 130 | published 19/19; time 223/223; seconds 223/223 | discovery thumbnail 19/19; cover 19/19 |

The batch4 report DB probe line `sakisakatsumugi: 16 videos / 202 occurrences` is local probe/cumulative context after a local YouTube-only rebuild. It is not this duplicate-evidence accepted delta. This batch97 accepted evidence uses the direct batch4 concrete accepted artifact and batch4 manifest source entry: 19 videos / 223 occurrences / 130 unique songs.

## Batch4 Source Manifest Entry

| Field | Value |
| --- | ---: |
| discoveryCandidateCount | 21 |
| discoveryInspectedCount | 21 |
| discoveryUsableVideoCount | 19 |
| discoveryOccurrenceCount | 223 |
| elapsedSeconds | 848 |
| reachedEnd | true |

## Dirty Audit

The dirty audit in this artifact is filtered only to `sakisakatsumugi`.

- Batch4 dirty audit dropped: 0 videos / 0 occurrences.
- Batch4 suspicious: 0 videos / 0 occurrences.
- The difference between 21 candidates and 19 usable videos is not dirty dropped.

## Remote Cleanup Evidence Referenced From Batch4

Batch97 did not use Mac, VPS, or any remote temporary directory. Batch4 report/manifest include these remote cleanup `df -h /` lines:

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch4-vps3`: removed; `df -h /` => `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch4-vps5`: removed; `df -h /` => `/dev/vda1 10G 2.6G 7.0G 27% /`.

## Outputs

Generated exactly these 5 small files in `artifacts/channel-discovery/2026-07-23-source-backfill-batch97-sakisakatsumugi-duplicate-evidence/`:

- `candidate-increment-unfiltered.json`
- `accepted-increment.json`
- `dirty-audit.json`
- `manifest.json`
- `report.md`
