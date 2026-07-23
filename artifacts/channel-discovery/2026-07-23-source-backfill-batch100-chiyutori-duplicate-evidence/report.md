# Batch100 Chiyutori Duplicate Evidence

Status: `skipped_duplicate`

Reason: `duplicate_concrete_accepted_artifact_exists`

Duplicate of batch: `2026-07-22-source-backfill-batch7`

## Scope

This is a duplicate-evidence artifact only. It did not rerun YouTube discovery, did not use Mac or VPS execution, did not create a remote temporary directory, did not write `data/external`, did not rebuild any production DB, and did not push, deploy, or publish anything.

The accepted increment is intentionally empty because `Chiyutori` is already fully recorded in the batch7 concrete accepted artifact. This batch does not repeat accepted rows.

## Evidence Sources

- `artifacts/channel-discovery/2026-07-22-source-backfill-batch7/accepted/2026-07-22-source-backfill-batch7.accepted.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch7/manifest.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch7/report.md`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch7/dirty-audit.json`

## Batch7 Chiyutori Accepted Evidence

| Channel | Status | Videos | Occurrences | Unique songs | Coverage | Cover coverage |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `Chiyutori` | skipped duplicate; already imported in batch7 | 27 | 909 | 459 | published 27/27; time 909/909; seconds 909/909 | discovery thumbnail 27/27; cover 27/27 |

The batch7 report channel probe `Chiyutori query 3/121 -> 26/920` is local DB context after a local YouTube-only rebuild. It is not this duplicate-evidence accepted delta. This batch100 accepted evidence uses the direct batch7 concrete accepted artifact and batch7 manifest source entry: 27 videos / 909 occurrences / 459 unique songs.

## Batch7 Source Manifest Entry

| Field | Value |
| --- | ---: |
| discoveryCandidateCount | 29 |
| discoveryInspectedCount | 29 |
| discoveryUsableVideoCount | 28 |
| discoveryOccurrenceCount | 967 |
| elapsedSeconds | 439 |
| reachedEnd | true |

## Dirty Audit

The dirty audit in this artifact is filtered only to `Chiyutori`.

- Batch7 dirty audit dropped: 0 videos / 0 occurrences.
- Batch7 suspicious: 3 videos retained after manual audit.
- Filtered Chiyutori suspicious: 3 videos / 98 occurrences retained after manual audit.
- Suspicious rows are not dropped rows.
- Broad `live` / `ライブ` hits were reviewed manually and were not applied blindly.

## Remote Cleanup Evidence Referenced From Batch7

Batch100 did not use Mac, VPS, or any remote temporary directory. Batch7 report/manifest include these remote cleanup `df -h /` lines:

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch7-vps3`: removed; df `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch7-vps5`: removed; df `/dev/vda1 10G 2.6G 7.0G 27% /`.

## Outputs

Generated exactly these 5 small files in `artifacts/channel-discovery/2026-07-23-source-backfill-batch100-chiyutori-duplicate-evidence/`:

- `candidate-increment-unfiltered.json`
- `accepted-increment.json`
- `dirty-audit.json`
- `manifest.json`
- `report.md`
