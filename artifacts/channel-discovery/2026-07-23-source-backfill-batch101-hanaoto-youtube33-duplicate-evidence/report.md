# Batch101 hanaoto_youtube33 Duplicate Evidence

Status: `skipped_duplicate`

Reason: `duplicate_concrete_accepted_artifact_exists`

Duplicate of batch: `2026-07-22-source-backfill-batch10`

## Scope

This is a duplicate-evidence artifact only. It did not rerun YouTube discovery, did not use Mac or VPS execution, did not create a remote temporary directory, did not write `data/external`, did not rebuild any production DB, and did not push, deploy, or publish anything.

The accepted increment is intentionally empty because `hanaoto_youtube33` is already recorded in the batch10 concrete accepted artifact. This batch does not repeat accepted rows.

## Evidence Sources

- `artifacts/channel-discovery/2026-07-22-source-backfill-batch10/accepted/2026-07-22-source-backfill-batch10.accepted.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch10/manifest.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch10/report.md`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch10/dirty-audit.json`

## Batch10 hanaoto_youtube33 Accepted Evidence

| Channel | Status | Videos | Occurrences | Unique songs | Coverage | Cover coverage |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `hanaoto_youtube33` | skipped duplicate; already imported in batch10 | 4 | 49 | 38 | published 4/4; time 49/49; seconds 49/49 | discovery thumbnail 4/4; cover 4/4 |

The batch10 report channel probe `hanaoto 0/0 -> 4/49` is local DB context after a local YouTube-only rebuild. It is not this duplicate-evidence accepted delta. This batch101 accepted evidence uses the direct batch10 concrete accepted artifact and batch10 manifest source entry: 4 videos / 49 occurrences / 38 unique songs.

## Batch10 Source Manifest Entry

| Field | Value |
| --- | ---: |
| discoveryCandidateCount | 104 |
| discoveryInspectedCount | 104 |
| discoveryUsableVideoCount | 58 |
| discoveryOccurrenceCount | 889 |
| elapsedSeconds | 2226 |
| reachedEnd | true |

## Dirty Audit

The dirty audit in this artifact is filtered only to `hanaoto_youtube33`.

- Batch10 dirty audit dropped for hanaoto: 54 videos / 840 occurrences.
- Dropped rows are flute/instrumental rows matched by exact `フルート` / `flute` filters.
- Batch10 suspicious total: 5 videos.
- Filtered hanaoto suspicious: 4 videos / 49 occurrences retained after manual audit.
- Suspicious rows are not dropped rows.
- Broad `live` / `ライブ` hits were reviewed manually and were not dropped blindly.

## Remote Cleanup Evidence Referenced From Batch10

Batch101 did not use Mac, VPS, or any remote temporary directory. Batch10 report/manifest include these remote cleanup `df -h /` lines:

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch10-vps3`: removed; df `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch10-vps5`: removed; df `/dev/vda1 10G 2.6G 7.0G 27% /`.

## Outputs

Generated exactly these 5 small files in `artifacts/channel-discovery/2026-07-23-source-backfill-batch101-hanaoto-youtube33-duplicate-evidence/`:

- `candidate-increment-unfiltered.json`
- `accepted-increment.json`
- `dirty-audit.json`
- `manifest.json`
- `report.md`
