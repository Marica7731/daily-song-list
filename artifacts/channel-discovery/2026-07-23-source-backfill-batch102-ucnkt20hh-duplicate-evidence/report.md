# Batch102 UCnKt20HH Duplicate Evidence

Status: `skipped_duplicate`

Reason: `duplicate_concrete_accepted_artifact_exists`

Duplicate of batch: `2026-07-22-source-backfill-batch10`

## Scope

This is a duplicate-evidence artifact only. It did not rerun YouTube discovery, did not use Mac or VPS execution, did not create a remote temporary directory, did not write `data/external`, did not rebuild any production DB, and did not push, deploy, or publish anything.

The accepted increment is intentionally empty because `UCnKt20HH_BiuID0FDHGMcvw` is already recorded in the batch10 concrete accepted artifact. This batch does not repeat accepted rows.

## Evidence Sources

- `artifacts/channel-discovery/2026-07-22-source-backfill-batch10/accepted/2026-07-22-source-backfill-batch10.accepted.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch10/manifest.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch10/report.md`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch10/dirty-audit.json`

## Batch10 UCnKt20HH Accepted Evidence

| Channel | Status | Videos | Occurrences | Unique songs | Coverage | Cover coverage |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `UCnKt20HH_BiuID0FDHGMcvw` | skipped duplicate; already imported in batch10 | 98 | 1312 | 767 | published 98/98; time 1312/1312; seconds 1312/1312 | discovery thumbnail 98/98; cover 98/98 |

The batch10 report channel probe `UCnKt20HH 2/31 -> 99/1322` is local DB context after a local YouTube-only rebuild. It is not this duplicate-evidence accepted delta. This batch102 accepted evidence uses the direct batch10 concrete accepted artifact and batch10 manifest source entry: 98 videos / 1312 occurrences / 767 unique songs.

## Batch10 Source Manifest Entry

| Field | Value |
| --- | ---: |
| discoveryCandidateCount | 116 |
| discoveryInspectedCount | 116 |
| discoveryUsableVideoCount | 99 |
| discoveryOccurrenceCount | 1321 |
| elapsedSeconds | 1384 |
| reachedEnd | true |

## Dirty Audit

The dirty audit in this artifact is filtered only to `UCnKt20HH_BiuID0FDHGMcvw`.

- Batch10 dirty audit dropped for this channel: 0 videos / 0 occurrences.
- Batch10 suspicious total: 5 videos.
- Filtered UCnKt20HH suspicious: 1 video / 13 occurrences retained after manual audit.
- Suspicious rows are not dropped rows.
- Broad `live` / `ライブ` hits were reviewed manually and were not dropped blindly.

## Remote Cleanup Evidence Referenced From Batch10

Batch102 did not use Mac, VPS, or any remote temporary directory. Batch10 report/manifest include these remote cleanup `df -h /` lines:

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch10-vps3`: removed; df `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch10-vps5`: removed; df `/dev/vda1 10G 2.6G 7.0G 27% /`.

## Outputs

Generated exactly these 5 small files in `artifacts/channel-discovery/2026-07-23-source-backfill-batch102-ucnkt20hh-duplicate-evidence/`:

- `candidate-increment-unfiltered.json`
- `accepted-increment.json`
- `dirty-audit.json`
- `manifest.json`
- `report.md`
