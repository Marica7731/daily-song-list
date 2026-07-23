# Batch99 kisaki Duplicate Evidence

Status: `skipped_duplicate`

Reason: `duplicate_concrete_accepted_artifact_exists`

Duplicate of batch: `2026-07-22-source-backfill-batch9`

## Scope

This is a duplicate-evidence artifact only. It did not rerun YouTube discovery, did not use Mac or VPS execution, did not create a remote temporary directory, did not write `data/external`, did not rebuild any production DB, and did not push, deploy, or publish anything.

The accepted increment is intentionally empty because `kisaki` is already fully recorded in the batch9 concrete accepted artifact. This batch does not repeat accepted rows.

## Evidence Sources

- `artifacts/channel-discovery/2026-07-22-source-backfill-batch9/accepted/2026-07-22-source-backfill-batch9.accepted.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch9/manifest.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch9/report.md`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch9/dirty-audit.json`

## Batch9 kisaki Accepted Evidence

| Channel | Status | Videos | Occurrences | Unique songs | Coverage | Cover coverage |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `kisaki` | skipped duplicate; already imported in batch9 | 16 | 194 | 175 | published 16/16; time 194/194; seconds 194/194 | discovery thumbnail 16/16; cover 16/16 |

The batch9 report probe line `kisaki 1/19 -> 17/213` is local probe/cumulative context after a local YouTube-only rebuild. It is not this duplicate-evidence accepted delta. This batch99 accepted evidence uses the direct batch9 concrete accepted artifact and batch9 manifest source entry: 16 videos / 194 occurrences / 175 unique songs.

## Batch9 Source Manifest Entry

| Field | Value |
| --- | ---: |
| discoveryCandidateCount | 34 |
| discoveryInspectedCount | 34 |
| discoveryUsableVideoCount | 17 |
| discoveryOccurrenceCount | 212 |
| elapsedSeconds | 376 |
| reachedEnd | true |

## Dirty Audit

The dirty audit in this artifact is filtered only to `kisaki`.

- Batch9 dirty audit dropped: 0 videos / 0 occurrences.
- Batch9 suspicious: 2 videos retained after manual audit.
- Filtered kisaki suspicious: 1 video / 14 occurrences retained after manual audit.
- Suspicious rows are not dropped rows.
- The difference between discovery usable 17 videos / 212 occurrences and direct accepted 16 videos / 194 occurrences is not dirty dropped. Direct accepted evidence is authoritative for duplicate stats, and no dropped rows are recorded in dirty-audit.

## Remote Cleanup Evidence Referenced From Batch9

Batch99 did not use Mac, VPS, or any remote temporary directory. Batch9 report/manifest include these remote cleanup `df -h /` lines:

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch9-vps3`: removed; df `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch9-vps5`: removed; df `/dev/vda1 10G 2.6G 7.0G 27% /`.

## Outputs

Generated exactly these 5 small files in `artifacts/channel-discovery/2026-07-23-source-backfill-batch99-kisaki-duplicate-evidence/`:

- `candidate-increment-unfiltered.json`
- `accepted-increment.json`
- `dirty-audit.json`
- `manifest.json`
- `report.md`
