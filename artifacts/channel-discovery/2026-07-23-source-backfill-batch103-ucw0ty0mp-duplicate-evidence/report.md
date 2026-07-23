# Batch103 UCw0ty0mp Duplicate Evidence

Status: `skipped_duplicate`

Reason: `duplicate_concrete_accepted_artifact_exists`

Duplicate of batch: `2026-07-22-source-backfill-batch11`

## Scope

This is a duplicate-evidence artifact only. It did not rerun YouTube discovery, did not use Mac or VPS execution, did not create a remote temporary directory, did not write `data/external`, did not rebuild any production DB, and did not push, deploy, or publish anything.

The accepted increment is intentionally empty because `UCw0ty0mpHBx6xZt-K_hfNcA` is already recorded in the batch11 concrete accepted artifact. This batch does not repeat accepted rows.

## Evidence Sources

- `artifacts/channel-discovery/2026-07-22-source-backfill-batch11/accepted/2026-07-22-source-backfill-batch11.accepted.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch11/manifest.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch11/report.md`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch11/dirty-audit.json`

## Batch11 UCw0ty0mp Accepted Evidence

| Channel | Status | Videos | Occurrences | Unique songs | Coverage | Cover coverage |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `UCw0ty0mpHBx6xZt-K_hfNcA` (`/@LEWNE_RKMusic`) | skipped duplicate; already imported in batch11 | 38 | 496 | 291 | published 38/38; time 496/496; seconds 496/496 | discovery thumbnail 38/38; cover 38/38 |

The batch11 report channel probe `1/14 -> 38/509` is local DB context after a local YouTube-only rebuild. It is not this duplicate-evidence accepted delta. This batch103 accepted evidence uses the direct batch11 concrete accepted artifact and batch11 manifest source entry: 38 videos / 496 occurrences / 291 unique songs.

## Batch11 Source Manifest Entry

| Field | Value |
| --- | ---: |
| discoveryCandidateCount | 121 |
| discoveryInspectedCount | 121 |
| discoveryUsableVideoCount | 38 |
| discoveryOccurrenceCount | 496 |
| elapsedSeconds | 1415 |
| reachedEnd | true |

## Dirty Audit

The dirty audit in this artifact is filtered to the requested channel ID and the concrete accepted channel handle `@LEWNE_RKMusic`.

- Batch11 dirty audit dropped for this channel: 0 videos / 0 occurrences.
- Batch11 suspicious total: 1 video.
- Filtered UCw0ty0mp suspicious: 1 video / 6 occurrences retained after manual audit.
- Suspicious rows are not dropped rows.
- Broad `live` / `ライブ` hits were reviewed manually and were not dropped blindly.

## Remote Cleanup Evidence Referenced From Batch11

Batch103 did not use Mac, VPS, or any remote temporary directory. Batch11 report/manifest include these remote cleanup `df -h /` lines:

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch11-vps3`: removed; df `/dev/sda1 99G 11G 89G 11% /`; marker `CODEX_REMOTE_BATCH11_CLEANUP_OK`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch11-vps5`: removed; df `/dev/vda1 10G 2.6G 7.0G 27% /`; marker `CODEX_REMOTE_BATCH11_CLEANUP_OK`.

## Outputs

Generated exactly these 5 small files in `artifacts/channel-discovery/2026-07-23-source-backfill-batch103-ucw0ty0mp-duplicate-evidence/`:

- `candidate-increment-unfiltered.json`
- `accepted-increment.json`
- `dirty-audit.json`
- `manifest.json`
- `report.md`
